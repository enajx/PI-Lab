import { BrowserWindow, dialog } from "electron"
import { z } from "zod"
import { applyTrafficLightInset } from "../../window/trafficLights"
import { publicProcedure, router } from "../trpc"

/**
 * System router — small bridges to native OS surfaces that only the main process
 * can reach (docs/architecture.md (process model)). Kept thin: each procedure validates nothing it
 * doesn't own and returns a plain, serializable result the renderer can act on.
 *
 * `pickDirectory` is the OS folder picker that backs the sidebar's "Add project"
 * action: the renderer asks for a directory, the user chooses one in the native
 * dialog, and the path flows back to `projects.open`. There is no automated way
 * to drive a native dialog, so the E2E never calls this — it uses the
 * `?openProject` seam in the renderer (docs/testing-and-build.md) to open a known path
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
      ? await dialog.showOpenDialog(parent, { properties: ["openDirectory", "createDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] ?? null
  }),

  /**
   * Open the native single-file picker (parented like `pickDirectory`), returning the
   * chosen absolute path or `null` on cancel. Backs "Attach file…" in the Library tab,
   * which hands the path to `science.library.attachFile`. Like `pickDirectory`, the
   * native dialog can't be driven by the E2E, so this is for real, human use.
   */
  pickFile: publicProcedure.mutation(async (): Promise<string | null> => {
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined
    const result = parent
      ? await dialog.showOpenDialog(parent, { properties: ["openFile"] })
      : await dialog.showOpenDialog({ properties: ["openFile"] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] ?? null
  }),

  /**
   * Reposition the macOS traffic lights (darwin-only; a no-op elsewhere). The
   * renderer's shell calls this whenever the lights' home changes: `inTitleBar`
   * moves them into the title-bar strip above the main panel — just right of the
   * collapsed 56px rail — while `false` resets them to the default sidebar-header
   * inset. The position math + darwin guard live in `window/trafficLights.ts` so
   * they stay unit-testable; here we only resolve the focused window. Returns
   * `{ applied }` so the caller can see whether the OS surface accepted it.
   */
  setTrafficLightInset: publicProcedure
    .input(z.object({ inTitleBar: z.boolean() }))
    .mutation(({ input }): { applied: boolean } => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      return { applied: applyTrafficLightInset(win, input.inTitleBar) }
    }),
})
