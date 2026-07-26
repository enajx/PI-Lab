import { BrowserWindow, dialog, type OpenDialogOptions } from "electron"
import { z } from "zod"
import {
  cacheSystemFontDetector,
  liveSystemFontDetector,
  type SystemFontDetector,
} from "../../fonts/systemFonts"
import { pickDirectoryOverride, testFontFamilies } from "../../runtime/env"
import { applyTrafficLightInset } from "../../window/trafficLights"
import { publicProcedure, router } from "../trpc"
import { type EditorThemeImportResult, readEditorThemeFiles } from "./themeImport"

/**
 * System router — small bridges to native OS surfaces that only the main process
 * can reach (md/engineering/architecture.md (process model)). Kept thin: each procedure validates nothing it
 * doesn't own and returns a plain, serializable result the renderer can act on.
 *
 * `pickDirectory` is the OS folder picker that backs the sidebar's "Add project"
 * action: the renderer asks for a directory, the user chooses one in the native
 * dialog, and the path flows back to `projects.open`. Native dialogs are not
 * automated; test mode can return `PI_LAB_TEST_PICK_DIRECTORY` instead so the
 * renderer's real chooser flow remains covered deterministically.
 */
export function createSystemRouter(detectSystemFonts: SystemFontDetector) {
  const detectSystemFontsOnce = cacheSystemFontDetector(detectSystemFonts)
  return router({
    /** System-installed font families for the global editor typography picker. */
    fonts: publicProcedure.query(() => detectSystemFontsOnce()),
    /**
     * Open the native single-directory picker, parented to the focused window so it
     * presents as a sheet on macOS. Returns the chosen absolute path, or `null`
     * when the user cancels (so the caller can no-op cleanly).
     */
    pickDirectory: publicProcedure.mutation(async (): Promise<string | null> => {
      if (pickDirectoryOverride) return pickDirectoryOverride
      const parent =
        BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined
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
      const parent =
        BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined
      const result = parent
        ? await dialog.showOpenDialog(parent, { properties: ["openFile"] })
        : await dialog.showOpenDialog({ properties: ["openFile"] })
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0] ?? null
    }),

    /**
     * Pick one or more VS Code JSON color themes and parse them inside main.
     * Absolute paths remain main-only; the renderer receives copied sanitized data.
     */
    importEditorThemes: publicProcedure.mutation(async (): Promise<EditorThemeImportResult> => {
      const parent =
        BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined
      const options: OpenDialogOptions = {
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "VS Code color themes", extensions: ["json"] }],
      }
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return { themes: [], errors: [] }
      return readEditorThemeFiles(result.filePaths)
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
}

function selectedSystemFontDetector(): SystemFontDetector {
  const override = testFontFamilies
  return override ? async () => ({ families: override, error: null }) : liveSystemFontDetector
}

export const systemRouter = createSystemRouter(selectedSystemFontDetector())
