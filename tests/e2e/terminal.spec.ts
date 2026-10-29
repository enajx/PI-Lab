import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  test,
} from "./fixtures/playwright"

/**
 * Whole-app E2E: launch the real Electron build, boot to
 * `app-ready`, then prove the terminal pane is wired end-to-end — spawn a PTY in
 * the daemon running a deterministic program, stream its bytes through tRPC into
 * xterm.js, and assert the marker shows in the terminal DOM.
 *
 * The terminal is driven by the test seam in `mainWindow.ts`/`App.tsx`: in test
 * mode `PI_LAB_TEST_TERMINAL_CMD` (+ JSON `PI_LAB_TEST_TERMINAL_ARGS`) become
 * the renderer's `?termcmd=…&termargs=…`, so the pane spawns our marker program
 * without needing synthetic keystrokes.
 *
 * MUST run under Node (not Bun) — Playwright's `_electron` launcher hangs under
 * the Bun runtime. The repo `e2e` script invokes Playwright's CLI
 * through `node` for exactly this reason.
 */

const MARKER = "E2E-TERM-OK"
const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")

/**
 * Electron is a devDependency of `apps/desktop`, not the repo root, so Playwright
 * can't auto-discover it. Resolve the binary path from the desktop package — the
 * `electron` module's main export is the absolute executable path.
 */
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

let app: ElectronApplication
let dataDir: string

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-term-"))
  // Each run gets its own throwaway data dir + socket so parallel/repeat runs
  // never collide and never adopt a stale daemon.
  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      // Spawn a tiny raw-input probe: it writes the boot marker, then reports
      // every renderer → xterm → IPC → real-PTY input chunk as hex.
      PI_LAB_TEST_TERMINAL_CMD: process.execPath,
      PI_LAB_TEST_TERMINAL_ARGS: JSON.stringify([
        "-e",
        [
          `process.stdout.write('${MARKER}\\n')`,
          "process.stdin.setRawMode?.(true)",
          "process.stdin.resume()",
          "let received = Buffer.alloc(0)",
          "process.stdin.on('data', chunk => { received = Buffer.concat([received, chunk]); process.stdout.write('\\r\\nE2E-INPUT-' + received.toString('hex') + '-COUNT-' + received.length + '\\r\\n') })",
        ].join(";"),
      ]),
    },
  })
})

test.afterEach(async () => {
  // The fixture terminal runs a Node process, so quitting asks; choose Quit and stop.
  await app
    ?.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    })
    .catch(() => undefined)
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("terminal pane streams PTY output into xterm", async () => {
  const window = await app.firstWindow()

  // Boot gate: the renderer proves renderer → IPC → main → SQLite is wired.
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  // The terminal mounts inside the ready surface.
  const terminal = window.getByTestId("terminal")
  await expect(terminal).toBeVisible()

  // xterm renders glyphs into its own DOM (rows of styled spans). Assert the
  // marker reaches the terminal — proving spawn → onData subscription → xterm
  // write all work over the real IPC link.
  await expect(terminal).toContainText(MARKER, { timeout: 30_000 })
})

test("terminal pane sends macOS editing keys to the real PTY exactly once", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const terminal = window.getByTestId("terminal")
  await expect(terminal).toContainText(MARKER, { timeout: 30_000 })
  const input = terminal.locator(".xterm-helper-textarea")
  await input.focus()

  await input.press("Shift+Enter")
  await expectLatestInput(terminal, process.platform === "darwin" ? "160a" : "0d")

  if (process.platform !== "darwin") return
  await input.press("Alt+Backspace")
  await expectLatestInput(terminal, "160a1b7f")
  await input.press("Meta+Backspace")
  await expectLatestInput(terminal, "160a1b7f15")

  const agentUrl = new URL(window.url())
  agentUrl.searchParams.set("termkind", "agent")
  await window.goto(agentUrl.toString())
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const agentTerminal = window.getByTestId("terminal")
  await expect(agentTerminal).toContainText(MARKER, { timeout: 30_000 })
  const agentInput = agentTerminal.locator(".xterm-helper-textarea")
  await agentInput.focus()

  await agentInput.press("Shift+Enter")
  await expectLatestInput(agentTerminal, process.platform === "darwin" ? "1b5b31333b3275" : "0d")
})

test("dropping local files inserts quoted paths into the real PTY without Enter", async () => {
  const filePaths = [join(dataDir, "file with spaces.txt"), join(dataDir, "lab's notes.txt")]
  await Promise.all(filePaths.map((path) => writeFile(path, "drop me\n")))
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const terminal = window.getByTestId("terminal")
  await expect(terminal).toContainText(MARKER, { timeout: 30_000 })

  await window.evaluate(() => {
    const input = document.createElement("input")
    input.type = "file"
    input.id = "terminal-drop-files"
    input.multiple = true
    document.body.append(input)
  })
  await window.locator("#terminal-drop-files").setInputFiles(filePaths)
  await window.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>("#terminal-drop-files")
    const terminal = document.querySelector<HTMLElement>('[data-testid="terminal"]')
    if (!input?.files?.length || !terminal) throw new Error("Missing test files or terminal")
    const transfer = new DataTransfer()
    for (const file of input.files) transfer.items.add(file)
    terminal.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    )
  })

  const quotedPaths = filePaths.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(" ")
  await expectLatestInput(terminal, Buffer.from(quotedPaths).toString("hex"))
})

test("dropping a local folder inserts its path into the real PTY without Enter", async () => {
  const folderPath = join(dataDir, "research folder")
  await mkdir(folderPath)
  await writeFile(join(folderPath, "notes.md"), "# Notes\n")
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const terminal = window.getByTestId("terminal")
  await expect(terminal).toContainText(MARKER, { timeout: 30_000 })
  const bounds = await terminal.boundingBox()
  if (!bounds) throw new Error("Terminal has no bounds")
  const session = await window.context().newCDPSession(window)
  const drag = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
    data: { items: [], files: [folderPath], dragOperationsMask: 1 },
  }
  await session.send("Input.dispatchDragEvent", { type: "dragEnter", ...drag })
  await session.send("Input.dispatchDragEvent", { type: "dragOver", ...drag })
  await session.send("Input.dispatchDragEvent", { type: "drop", ...drag })

  await expectLatestInput(terminal, Buffer.from(`'${folderPath}'`).toString("hex"))
})

async function expectLatestInput(terminal: Locator, expectedHex: string): Promise<void> {
  await expect
    .poll(async () => {
      const text = (await terminal.textContent()) ?? ""
      const matches = Array.from(text.matchAll(/E2E-INPUT-([0-9a-f]+)-COUNT-(\d+)/gu))
      return matches.at(-1)?.[0] ?? null
    })
    .toBe(`E2E-INPUT-${expectedHex}-COUNT-${expectedHex.length / 2}`)
}
