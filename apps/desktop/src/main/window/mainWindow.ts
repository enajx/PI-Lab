import { join } from "node:path"
import { BrowserWindow } from "electron"
import { isTestMode, rendererDevServerUrl, testFirstRun } from "../runtime/env"
import { buildMainWindowOptions } from "./windowOptions"

/**
 * Test seams (md/engineering/testing-and-build.md): in test mode the E2E harness drives the app through
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
 * Security posture (md/engineering/architecture.md (process model)): context isolation ON, node integration OFF,
 * sandboxed renderer; the only main↔renderer bridge is the preload's
 * `exposeElectronTRPC()`. In dev the renderer comes from the Vite dev server
 * (`ELECTRON_RENDERER_URL`); in a packaged build it's the built HTML that sits
 * at `out/renderer/index.html`, i.e. `../renderer/index.html` next to this
 * compiled `out/main/index.js`.
 */
export function createMainWindow(iconPath: string | null): BrowserWindow {
  const window = new BrowserWindow(
    buildMainWindowOptions(iconPath, join(__dirname, "../preload/index.js"), process.platform),
  )

  window.once("ready-to-show", () => window.show())

  const query = testSeamQuery()
  if (rendererDevServerUrl) {
    const url = query ? `${rendererDevServerUrl}?${query}` : rendererDevServerUrl
    void window.loadURL(url)
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"), query ? { search: query } : {})
  }

  return window
}
