import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "./fixtures/playwright"
import { readServerDiscovery } from "./fixtures/serverClient"

/**
 * Whole-app E2E for the connection layer (plan done check "Disconnects", the
 * killed tunnel case): the real build, its detached PI Lab server and PTY
 * daemon. The server closes every client WebSocket at once (test-mode route
 * `POST /test/drop-connections`, as a killed SSH tunnel would); the status bar
 * shows Reconnecting, then Connected, and the open terminal continues with no
 * user action: no output is lost or shown twice.
 */
const execFileAsync = promisify(execFile)
const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

let app: ElectronApplication
let dataDir: string
let repoDir: string

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-connection-"))
  repoDir = join(dataDir, "repo")
  await execFileAsync("git", ["init", "-b", "main", repoDir])
  await writeFile(join(repoDir, "notes.md"), "# Connection fixture\n")
  const git = (args: string[]) => execFileAsync("git", ["-C", repoDir, ...args])
  await git(["add", "."])
  await git([
    "-c",
    "user.name=PI Lab Test",
    "-c",
    "user.email=test@pi-lab.local",
    "commit",
    "-m",
    "fixture",
  ])
  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: repoDir,
    },
  })
})

test.afterEach(async () => {
  // The open shell makes quitting ask; choose Quit and stop.
  await app
    ?.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    })
    .catch(() => undefined)
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

async function turnOnStatusBar(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+Shift+p")
  await page.getByTestId("command-palette-input").fill("status bar")
  const command = page.locator('[data-command-id="settings-status-bar"]')
  await expect(command).toContainText("Turn on Status bar")
  await command.click()
  await expect(page.getByTestId("window-status-bar")).toBeVisible()
}

/** Close every client WebSocket from the server side. */
async function dropServerConnections(): Promise<void> {
  const discovery = readServerDiscovery(dataDir)
  if (!discovery) throw new Error("no server.json")
  const token = (await readFile(join(dataDir, "server-token"), "utf8")).trim()
  const response = await fetch(`http://127.0.0.1:${discovery.port}/test/drop-connections`, {
    method: "POST",
    headers: { "x-pi-lab-token": token },
  })
  expect(response.status).toBe(204)
}

function count(text: string, marker: string): number {
  return text.split(marker).length - 1
}

test("a killed connection shows Reconnecting, then Connected, and the terminal recovers on its own", async () => {
  const page = await app.firstWindow()
  await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await turnOnStatusBar(page)
  const connection = page.getByTestId("status-bar-connection")
  await expect(connection).toHaveText("Connected")

  await page.getByTestId("project-item").click()
  await page.getByTestId("central-add-menu").click()
  await page.getByTestId("central-add-terminal").click()
  const terminal = page.locator('[data-testid="terminal"]:visible')
  await expect(terminal).toBeVisible({ timeout: 30_000 })
  const input = terminal.locator(".xterm-helper-textarea")
  await input.focus()
  // printf with a split argument: the marker appears only in the output, never in the echo.
  await page.keyboard.insertText("printf 'BEFORE-%s\\n' DROP\r")
  await expect(terminal).toContainText("BEFORE-DROP")
  const before = count((await terminal.textContent()) ?? "", "BEFORE-DROP")

  // Record every state the indicator shows; Reconnecting can be brief on loopback.
  await page.evaluate(() => {
    const element = document.querySelector('[data-testid="status-bar-connection"]')
    if (!element) throw new Error("no connection indicator")
    const seen: string[] = []
    ;(window as unknown as { connectionStates: string[] }).connectionStates = seen
    new MutationObserver(() => seen.push(element.textContent ?? "")).observe(element, {
      subtree: true,
      childList: true,
      characterData: true,
    })
  })
  await dropServerConnections()
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { connectionStates: string[] }).connectionStates),
    )
    .toContain("Reconnecting")
  await expect(connection).toHaveText("Connected")

  await input.focus()
  await page.keyboard.insertText("printf 'AFTER-%s\\n' DROP\r")
  await expect(terminal).toContainText("AFTER-DROP")
  expect(count((await terminal.textContent()) ?? "", "BEFORE-DROP")).toBe(before)
})
