import { BrowserWindow, dialog } from "electron"
import { publicProcedure, router } from "../trpc"

/**
 * System router — small bridges to native OS surfaces that only the main process
 * can reach (AGENTS.md §6). Kept thin: each procedure validates nothing it
 * doesn't own and returns a plain, serializable result the renderer can act on.
 *
 * `pickDirectory` is the OS folder picker that backs the sidebar's "Add project"
 * action: the renderer asks for a directory, the user chooses one in the native
 * dialog, and the path flows back to `projects.open`. There is no automated way
 * to drive a native dialog, so the E2E never calls this — it uses the
 * `?openProject` seam in the renderer (AGENTS.md §14) to open a known path
 * directly. This procedure stays for real, human use.
 */
export const systemRouter = router({
  /**
   * Open the native single-directory picker, parented to the focused window so it
   * presents as a sheet on macOS. Returns the chosen absolute path, or `null`
   * when the user cancels (so the caller can no-op cleanly).
   */
  pickDirectory: publicProcedure.mutation(async (): Promise<string | null> => {
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined
    const result = parent
      ? await dialog.showOpenDialog(parent, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] ?? null
  }),
})
