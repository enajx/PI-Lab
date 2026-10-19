import { join } from "node:path"
import { BrowserWindow } from "electron"
import { isTestMode, rendererDevServerUrl, testFirstRun } from "../runtime/env"
import { buildMainWindowOptions } from "./windowOptions"

/**
 * Test seams: in test mode the E2E harness drives the app through
 * renderer URL query params (read from `window.location.search`, which hash
 * routing leaves untouched). We translate a small set of env vars into those
 * params so the harness can act deterministically without native dialogs or
 * synthetic keystrokes. All are ignored entirely outside test mode.
 *
 *   - `PI_LAB_TEST_TERMINAL_CMD` (+ JSON `PI_LAB_TEST_TERMINAL_ARGS`) → the
 *     index terminal spawns this deterministic program (`?termcmd`/`?termargs`).
 *   - `PI_LAB_TEST_OPEN_PROJECT` → the sidebar opens this absolute path as a
 *     project on load (`?openProject`), so the harness needn't drive the native
 *     folder picker.
 *   - `PI_LAB_TEST_PICK_DIRECTORY` → `system.pickDirectory` returns this path
 *     directly, so chooser E2Es can exercise the real renderer flow.
 *   - `PI_LAB_TEST_AGENT_ID` → the project view launches this agent id
 *     (`?agentId`), so the harness can pick the deterministic test agent.
 *   - `PI_LAB_TEST_SSH_CONFIG` → the Cluster science tab imports machines from
 *     this ssh-config path on mount (`?sshConfigPath`), so the harness seeds
 *     deterministic machines from a fixture instead of the real `~/.ssh/config`.
 *   - setup defaults to skipped so existing E2E suites are not blocked by the
 *     first-launch route. `PI_LAB_TEST_FIRST_RUN=1` omits that bypass so the
 *     dedicated setup spec exercises the real SQLite completion marker.
 */
function testSeamQuery(): string {
  if (!isTestMode) return ""
  const params = new URLSearchParams()

  const command = process.env.PI_LAB_TEST_TERMINAL_CMD?.trim()
  if (command) {
    params.set("termcmd", command)
    const rawArgs = process.env.PI_LAB_TEST_TERMINAL_ARGS?.trim()
    if (rawArgs) params.set("termargs", rawArgs)
  }

  const openProject = process.env.PI_LAB_TEST_OPEN_PROJECT?.trim()
  if (openProject) params.set("openProject", openProject)

  const agentId = process.env.PI_LAB_TEST_AGENT_ID?.trim()
  if (agentId) params.set("agentId", agentId)

  const sshConfig = process.env.PI_LAB_TEST_SSH_CONFIG?.trim()
  if (sshConfig) params.set("sshConfigPath", sshConfig)

  if (!testFirstRun) params.set("setup", "skip")

  return params.toString()
}

/**
 * Create the single application window and load the renderer.
 *
 * Security posture: context isolation ON, node integration OFF,
 * sandboxed renderer; preload exposes tRPC and the narrow shutdown request/response
 * bridge. In dev the renderer comes from the Vite dev server
 * (`ELECTRON_RENDERER_URL`); in a packaged build it's the built HTML that sits
 * at `out/renderer/index.html`, i.e. `../renderer/index.html` next to this
 * compiled `out/main/index.js`.
 */
export function createMainWindow(
  iconPath: string | null,
  page: "full" | "quick",
  hash: string | undefined,
): BrowserWindow {
  const window = new BrowserWindow(
    buildMainWindowOptions(
      iconPath,
      join(__dirname, "../preload/index.js"),
      process.platform,
      isTestMode && process.env.PI_LAB_TEST_HIDE_WINDOWS === "1",
    ),
  )

  if (isTestMode && process.env.PI_LAB_TEST_HIDE_WINDOWS === "1") {
    window.setIgnoreMouseEvents(true)
  }

  window.once("ready-to-show", () => {
    if (isTestMode && process.env.PI_LAB_TEST_HIDE_WINDOWS === "1") return
    if (isTestMode) window.showInactive()
    else window.show()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.webContents.on("will-navigate", (event, navigationUrl) => {
    const currentUrl = window.webContents.getURL()
    if (!currentUrl) return
    if (new URL(navigationUrl).origin !== new URL(currentUrl).origin) {
      event.preventDefault()
    }
  })

  loadWindowPage(window, page, hash)

  return window
}

/** Load either the small quick editor or the full app into an existing window. */
export function loadWindowPage(
  window: BrowserWindow,
  page: "full" | "quick",
  hash?: string,
): Promise<void> {
  const query = testSeamQuery()
  if (rendererDevServerUrl) {
    const url = new URL(page === "quick" ? "quick.html" : "index.html", rendererDevServerUrl)
    if (query) url.search = query
    if (hash) url.hash = hash
    return window.loadURL(url.toString())
  }
  return window.loadFile(
    join(__dirname, `../renderer/${page === "quick" ? "quick" : "index"}.html`),
    {
      ...(query ? { search: query } : {}),
      ...(hash ? { hash } : {}),
    },
  )
}
