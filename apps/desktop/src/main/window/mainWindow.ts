import { join } from "node:path"
import { BrowserWindow } from "electron"
import { rendererDevServerUrl } from "../runtime/env"

/**
 * Create the single application window and load the renderer.
 *
 * Security posture (AGENTS.md §6): context isolation ON, node integration OFF,
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
    show: false,
    backgroundColor: "#101014",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.once("ready-to-show", () => window.show())

  if (rendererDevServerUrl) {
    void window.loadURL(rendererDevServerUrl)
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"))
  }

  return window
}
