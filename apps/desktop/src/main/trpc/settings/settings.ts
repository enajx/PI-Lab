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
 * Settings router — read/write the singleton app-config row (docs/architecture.md (renderer)
 * "Settings"). v1 exposes the editor-preferences slice the built-in editor needs
 * (autosave / vim / type checker / format-on-save; AGENTS.md "Scope", TODO "Built-in
 * editor"); other settings groups mount here as later phases wire their UIs.
 *
 * The router stays thin (docs/testing-and-build.md): `get` reads through
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
  editorTheme: z.string().optional(),
})

/** Validation for a general-settings patch — all fields optional, merged onto current. */
const generalPatch = z.object({
  worktreePerAgent: z.boolean().optional(),
  confirmOnQuit: z.boolean().optional(),
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

/** The general-settings columns this router patches (top-level, not a JSON blob). */
export type GeneralSettings = Pick<Settings, "worktreePerAgent" | "confirmOnQuit">

/**
 * Merge a general-settings patch onto the current row and persist it, upserting
 * the singleton row (id=1) so a fresh DB with no settings row still saves. These
 * are top-level columns (not the `editor` JSON blob), so only the provided fields
 * are written and any omitted field keeps its current value. Returns the full,
 * persisted {@link Settings} row.
 */
export function writeGeneralSettings(
  db: SkipperDatabase,
  patch: Partial<GeneralSettings>,
): Settings {
  const current = getSettingsOrDefaults(db)
  const next: GeneralSettings = {
    worktreePerAgent: patch.worktreePerAgent ?? current.worktreePerAgent,
    confirmOnQuit: patch.confirmOnQuit ?? current.confirmOnQuit,
  }
  db.insert(settings)
    .values({ id: SETTINGS_ROW_ID, ...next, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: settings.id,
      set: { ...next, updatedAt: Date.now() },
    })
    .run()
  return getSettingsOrDefaults(db)
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

  /**
   * Patch the general app preferences (worktree-per-agent policy, confirm-on-quit).
   * Returns the full settings row after the merge so the renderer can update its
   * cache.
   */
  updateGeneral: publicProcedure
    .input(generalPatch)
    .mutation(({ ctx, input }): Settings => writeGeneralSettings(ctx.db, input)),
})
