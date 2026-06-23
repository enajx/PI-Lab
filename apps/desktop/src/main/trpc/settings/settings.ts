import {
  DEFAULT_EDITOR_SETTINGS,
  type EditorSettings,
  getSettingsOrDefaults,
  SETTINGS_ROW_ID,
  type Settings,
  type SkipperDatabase,
  settings,
} from "@skipper/local-db"
import { z } from "zod"
import { publicProcedure, router } from "../trpc"

/**
 * Settings router — read/write the singleton app-config row (AGENTS.md §7
 * "Settings"). v1 exposes the editor-preferences slice the built-in editor needs
 * (autosave / vim / type checker / format-on-save; AGENTS.md §1, TODO "Built-in
 * editor"); other settings groups mount here as later phases wire their UIs.
 *
 * The router stays thin (AGENTS.md §14): `get` reads through
 * {@link getSettingsOrDefaults} (defaults when no row exists yet, never writes),
 * and `updateEditor` upserts the single row with the new `editor` blob. The logic
 * lives in the plain {@link writeEditorSettings} function so it is
 * `createCaller`-testable without a window.
 */

/** Validation for an editor-settings patch — all fields optional, merged onto current. */
const editorPatch = z.object({
  autosave: z.boolean().optional(),
  vim: z.boolean().optional(),
  typeChecker: z.enum(["ty", "pyrefly"]).optional(),
  formatOnSave: z.boolean().optional(),
})

/**
 * Merge an editor-settings patch onto the current row and persist it, upserting
 * the singleton row (id=1) so a fresh DB with no settings row still saves. The
 * merge keeps any key the patch omits, so a UI toggle writes just its own field.
 * Returns the full, persisted {@link EditorSettings}.
 */
export function writeEditorSettings(
  db: SkipperDatabase,
  patch: Partial<EditorSettings>,
): EditorSettings {
  const current = getSettingsOrDefaults(db).editor ?? DEFAULT_EDITOR_SETTINGS
  const next: EditorSettings = { ...current, ...patch }
  db.insert(settings)
    .values({ id: SETTINGS_ROW_ID, editor: next, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: settings.id,
      set: { editor: next, updatedAt: Date.now() },
    })
    .run()
  return next
}

export const settingsRouter = router({
  /** The current settings row, or schema defaults when none has been persisted. */
  get: publicProcedure.query(({ ctx }): Settings => getSettingsOrDefaults(ctx.db)),

  /**
   * Patch the built-in editor preferences (TODO "Built-in editor"). Returns the
   * full editor settings after the merge so the renderer can update its cache.
   */
  updateEditor: publicProcedure
    .input(editorPatch)
    .mutation(({ ctx, input }): EditorSettings => writeEditorSettings(ctx.db, input)),
})
