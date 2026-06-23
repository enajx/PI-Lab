import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

/**
 * Whole-app E2E (AGENTS.md §14): launch the real Electron build, boot to
 * `app-ready`, then prove the terminal pane is wired end-to-end — spawn a PTY in
 * the daemon running a deterministic program, stream its bytes through tRPC into
 * xterm.js, and assert the marker shows in the terminal DOM.
 *
 * The terminal is driven by the test seam in `mainWindow.ts`/`App.tsx`: in test
 * mode `SKIPPER_TEST_TERMINAL_CMD` (+ JSON `SKIPPER_TEST_TERMINAL_ARGS`) become
 * the renderer's `?termcmd=…&termargs=…`, so the pane spawns our marker program
 * without needing synthetic keystrokes.
 *
 * MUST run under Node (not Bun) — Playwright's `_electron` launcher hangs under
 * the Bun runtime (AGENTS.md §13). The repo `e2e` script invokes Playwright's CLI
 * through `node` for exactly this reason.
 */

const MARKER = "E2E-TERM-OK"
const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "apps", "desktop")
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
  dataDir = await mkdtemp(join(tmpdir(), "skipper-e2e-term-"))
  // Each run gets its own throwaway data dir + socket so parallel/repeat runs
  // never collide and never adopt a stale daemon (AGENTS.md §14).
  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      SKIPPER_TEST_MODE: "1",
      SKIPPER_DATA_DIR: dataDir,
      SKIPPER_SOCKET_PATH: join(dataDir, "daemon.sock"),
      // Spawn a tiny Node program that writes the marker then exits — fully
      // deterministic, no network, no credentials.
      SKIPPER_TEST_TERMINAL_CMD: process.execPath,
      SKIPPER_TEST_TERMINAL_ARGS: JSON.stringify(["-e", `process.stdout.write('${MARKER}\\n')`]),
    },
  })
})

test.afterEach(async () => {
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
