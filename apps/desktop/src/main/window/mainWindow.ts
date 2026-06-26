import { join } from "node:path"
import { BrowserWindow } from "electron"
import { isTestMode, rendererDevServerUrl } from "../runtime/env"

/**
 * Test seams (docs/testing-and-build.md): in test mode the E2E harness drives the app through
 * renderer URL query params (read from `window.location.search`, which hash
 * routing leaves untouched). We translate a small set of env vars into those
 * params so the harness can act deterministically without native dialogs or
 * synthetic keystrokes. All are ignored entirely outside test mode.
 *
 *   - `SKIPPER_TEST_TERMINAL_CMD` (+ JSON `SKIPPER_TEST_TERMINAL_ARGS`) → the
 *     index terminal spawns this deterministic program (`?termcmd`/`?termargs`).
 *   - `SKIPPER_TEST_OPEN_PROJECT` → the sidebar opens this absolute path as a
 *     project on load (`?openProject`), so the harness needn't drive the native
 *     folder picker.
 *   - `SKIPPER_TEST_AGENT_ID` → the project view launches this agent id
 *     (`?agentId`), so the harness can pick the deterministic test agent.
 *   - `SKIPPER_TEST_SSH_CONFIG` → the Cluster science tab imports machines from
 *     this ssh-config path on mount (`?sshConfigPath`), so the harness seeds
 *     deterministic machines from a fixture instead of the real `~/.ssh/config`.
 */
function testSeamQuery(): string {
  if (!isTestMode) return ""
  const params = new URLSearchParams()

  const command = process.env.SKIPPER_TEST_TERMINAL_CMD?.trim()
  if (command) {
    params.set("termcmd", command)
    const rawArgs = process.env.SKIPPER_TEST_TERMINAL_ARGS?.trim()
    if (rawArgs) params.set("termargs", rawArgs)
  }

  const openProject = process.env.SKIPPER_TEST_OPEN_PROJECT?.trim()
  if (openProject) params.set("openProject", openProject)

  const agentId = process.env.SKIPPER_TEST_AGENT_ID?.trim()
  if (agentId) params.set("agentId", agentId)

  const sshConfig = process.env.SKIPPER_TEST_SSH_CONFIG?.trim()
  if (sshConfig) params.set("sshConfigPath", sshConfig)

  return params.toString()
}

/**
 * Create the single application window and load the renderer.
 *
 * Security posture (docs/architecture.md (process model)): context isolation ON, node integration OFF,
 * sandboxed renderer; the only main↔renderer bridge is the preload's
 * `exposeElectronTRPC()`. In dev the renderer comes from the Vite dev server
 * (`ELECTRON_RENDERER_URL`); in a packaged build it's the built HTML that sits
 * at `out/renderer/index.html`, i.e. `../renderer/index.html` next to this
 * compiled `out/main/index.js`.
 */
export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    // Floor on the window size so the sidebar + main panes can't be crushed to a
    // broken layout (the icon rail + a usable pane need this much room).
    minWidth: 900,
    minHeight: 600,
    show: false,
    // Light by default; this is only the pre-paint flash color before the
    // renderer mounts its theme.
    backgroundColor: "#ffffff",
    // macOS: hide the title bar and inset the traffic lights so the app's own
    // surface (the sidebar) extends to the top edge and the chrome "blends" —
    // no separate title-bar strip. The renderer marks a drag region at the top.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 18 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

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
