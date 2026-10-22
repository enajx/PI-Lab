import {
  type AgentSettings,
  agentSettings,
  type CaffeineSettings,
  DEFAULT_CAFFEINE_SETTINGS,
  DEFAULT_EDITOR_SETTINGS,
  DEFAULT_NOTIFICATION_SETTINGS,
  type EditorSettings,
  getAgentSettingsOrDefaults,
  getSettingsOrDefaults,
  type NotificationEventSettings,
  type NotificationSettings,
  type PiLabDatabase,
  type ProjectTemplateSettings,
  type ProjectType,
  SETTINGS_ROW_ID,
  type Settings,
  settings,
} from "@pi-lab/local-db"
import { AGENT_EFFORT_LEVELS } from "@pi-lab/shared"
import { TRPCError } from "@trpc/server"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { publishPublicUpdateChannelChanged } from "../../updates/selection"
import { publicProcedure, router } from "../trpc"

/**
 * Settings router — read/write the singleton app-config row. v1 exposes the editor-preferences slice the built-in editor needs
 * (autosave / vim / type checker / format-on-save); other settings groups mount here as later phases wire their UIs.
 *
 * The router stays thin: `get` reads through
 * {@link getSettingsOrDefaults} (defaults when no row exists yet, never writes),
 * and `updateEditor` upserts the single row with the new `editor` blob. The logic
 * lives in the plain {@link writeEditorSettings} function so it is
 * `createCaller`-testable without a window.
 */

/** Validation for an editor-settings patch — all fields optional, merged onto current. */
const importedThemeColor = z.string().regex(/^#[0-9a-f]{3,4}(?:[0-9a-f]{3,4})?$/iu)
const importedTheme = z.object({
  id: z.string().startsWith("custom:").max(160),
  name: z.string().min(1).max(100),
  mode: z.enum(["light", "dark"]),
  colors: z.object({
    background: importedThemeColor,
    foreground: importedThemeColor,
    caret: importedThemeColor.optional(),
    selection: importedThemeColor.optional(),
    selectionMatch: importedThemeColor.optional(),
    lineHighlight: importedThemeColor.optional(),
    gutterBackground: importedThemeColor.optional(),
    gutterForeground: importedThemeColor.optional(),
    activeLineNumber: importedThemeColor.optional(),
  }),
  tokenColors: z
    .array(
      z.object({
        scopes: z.array(z.string().min(1).max(160)).max(64),
        foreground: importedThemeColor.optional(),
        fontStyle: z.string().max(32).optional(),
      }),
    )
    .max(512),
})

const editorPatch = z.object({
  autosave: z.boolean().optional(),
  vim: z.boolean().optional(),
  diagnosticsEnabled: z.boolean().optional(),
  typeChecker: z.enum(["ty", "pyrefly"]).optional(),
  formatOnSave: z.boolean().optional(),
  editorTheme: z.string().optional(),
  customEditorThemes: z.array(importedTheme).max(100).optional(),
  pythonRunDestination: z.enum(["central", "below-editor"]).optional(),
})

/** Validation for a general-settings patch — all fields optional, merged onto current. */
const generalPatch = z.object({
  worktreePerAgent: z.boolean().optional(),
  confirmOnQuit: z.boolean().optional(),
  keepRunningAfterClose: z.boolean().optional(),
  publicUpdateChannel: z.enum(["stable", "beta"]).optional(),
})

const launchDefault = z.object({
  model: z.string().trim().max(256).optional(),
  effort: z.string().optional(),
})
const launchDefaults = z.record(z.string(), launchDefault).superRefine((defaults, ctx) => {
  for (const [id, values] of Object.entries(defaults)) {
    if (
      !AGENT_EFFORT_LEVELS[id] ||
      (values.effort && !AGENT_EFFORT_LEVELS[id].includes(values.effort))
    ) {
      ctx.addIssue({ code: "custom", path: [id], message: "Unsupported agent or effort" })
    }
  }
})

const agentsPatch = z.object({
  defaultAgentId: z.string().trim().min(1).optional(),
  launchDefaults: launchDefaults.optional(),
  quitBehavior: z.enum(["stop", "keep-running"]).optional(),
  projectConfigStorage: z.enum(["app", "project", "both"]).optional(),
  executableOverrides: z.record(z.string(), z.string().trim()).optional(),
  setupCompleted: z.boolean().optional(),
})

/** Runtime validation for one notification event's partial settings patch. */
const notificationEventPatch = z.object({
  enabled: z.boolean().optional(),
  sound: z.enum(["chime", "pulse", "success", "alert", "silent"]).optional(),
})

/**
 * Validation for notification settings. Event objects are partial too, so a
 * toggle or sound picker can update its own value without clobbering the other.
 */
const notificationsPatch = z.object({
  muted: z.boolean().optional(),
  agentInput: notificationEventPatch.optional(),
  agentTurnCompletion: notificationEventPatch.optional(),
  terminalCompletion: notificationEventPatch.optional(),
  workflowStart: notificationEventPatch.optional(),
  workflowCompletion: notificationEventPatch.optional(),
  workflowFailure: notificationEventPatch.optional(),
})

const projectTemplatePatch = z.object({
  initializationMarkdownFiles: z.array(z.string().min(1)).max(100).optional(),
  defaultTemplateParentPath: z.string().min(1).nullable().optional(),
})

const projectTypeGuidanceInput = z.object({
  id: z.enum(["research", "software", "manuscript"]),
  guidance: z.string().max(20_000),
})

type NotificationEventPatch = Partial<NotificationEventSettings>

/** A deep partial of the notification settings group. */
export interface NotificationSettingsPatch {
  muted?: boolean
  agentInput?: NotificationEventPatch
  agentTurnCompletion?: NotificationEventPatch
  terminalCompletion?: NotificationEventPatch
  workflowStart?: NotificationEventPatch
  workflowCompletion?: NotificationEventPatch
  workflowFailure?: NotificationEventPatch
}

/**
 * Merge an editor-settings patch onto the current row and persist it, upserting
 * the singleton row (id=1) so a fresh DB with no settings row still saves. The
 * merge keeps any key the patch omits, so a UI toggle writes just its own field.
 * Returns the full, persisted {@link EditorSettings}.
 */
export function writeEditorSettings(
  db: PiLabDatabase,
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
export type GeneralSettings = Pick<
  Settings,
  "worktreePerAgent" | "confirmOnQuit" | "keepRunningAfterClose" | "publicUpdateChannel"
>

/**
 * Merge a general-settings patch onto the current row and persist it, upserting
 * the singleton row (id=1) so a fresh DB with no settings row still saves. These
 * are top-level columns (not the `editor` JSON blob), so only the provided fields
 * are written and any omitted field keeps its current value. Returns the full,
 * persisted {@link Settings} row.
 */
export function writeGeneralSettings(db: PiLabDatabase, patch: Partial<GeneralSettings>): Settings {
  const current = getSettingsOrDefaults(db)
  const next: GeneralSettings = {
    worktreePerAgent: patch.worktreePerAgent ?? current.worktreePerAgent,
    confirmOnQuit: patch.confirmOnQuit ?? current.confirmOnQuit,
    keepRunningAfterClose: patch.keepRunningAfterClose ?? current.keepRunningAfterClose,
    publicUpdateChannel: patch.publicUpdateChannel ?? current.publicUpdateChannel,
  }
  db.insert(settings)
    .values({ id: SETTINGS_ROW_ID, ...next, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: settings.id,
      set: { ...next, updatedAt: Date.now() },
    })
    .run()
  if (next.publicUpdateChannel !== current.publicUpdateChannel) {
    publishPublicUpdateChannelChanged(next.publicUpdateChannel)
  }
  return getSettingsOrDefaults(db)
}

export function writeAgentSettings(
  db: PiLabDatabase,
  patch: Partial<AgentSettings>,
): AgentSettings {
  const current = getAgentSettingsOrDefaults(db)
  const launchDefaults = { ...current.launchDefaults }
  for (const [id, values] of Object.entries(patch.launchDefaults ?? {})) {
    launchDefaults[id] = { ...launchDefaults[id], ...values }
  }
  const next: AgentSettings = {
    quitBehavior: patch.quitBehavior ?? current.quitBehavior,
    defaultAgentId: patch.defaultAgentId ?? current.defaultAgentId,
    launchDefaults,
    projectConfigStorage: patch.projectConfigStorage ?? current.projectConfigStorage,
    executableOverrides: patch.executableOverrides ?? current.executableOverrides,
    setupCompleted: patch.setupCompleted ?? current.setupCompleted,
  }
  db.insert(agentSettings)
    .values({ id: SETTINGS_ROW_ID, ...next, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: agentSettings.id,
      set: { ...next, updatedAt: Date.now() },
    })
    .run()
  return next
}

/**
 * Deep-merge and persist notification preferences on the singleton settings
 * row. The event-level merge is intentional: changing a sound must retain that
 * event's enablement and vice versa.
 */
export function writeNotificationSettings(
  db: PiLabDatabase,
  patch: NotificationSettingsPatch,
): NotificationSettings {
  const current = getSettingsOrDefaults(db).notifications ?? DEFAULT_NOTIFICATION_SETTINGS
  const next: NotificationSettings = {
    muted: patch.muted ?? current.muted,
    agentInput: { ...current.agentInput, ...patch.agentInput },
    agentTurnCompletion: {
      ...current.agentTurnCompletion,
      ...patch.agentTurnCompletion,
    },
    terminalCompletion: { ...current.terminalCompletion, ...patch.terminalCompletion },
    workflowStart: { ...current.workflowStart, ...patch.workflowStart },
    workflowCompletion: { ...current.workflowCompletion, ...patch.workflowCompletion },
    workflowFailure: { ...current.workflowFailure, ...patch.workflowFailure },
  }
  db.insert(settings)
    .values({ id: SETTINGS_ROW_ID, notifications: next, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: settings.id,
      set: { notifications: next, updatedAt: Date.now() },
    })
    .run()
  return next
}

/**
 * Merge and persist caffeine preferences. Exported so the caffeine controller's
 * mutation can save the choice before immediately reconciling its blocker.
 */
export function writeCaffeineSettings(
  db: PiLabDatabase,
  patch: Partial<CaffeineSettings>,
): CaffeineSettings {
  const current = getSettingsOrDefaults(db).caffeine ?? DEFAULT_CAFFEINE_SETTINGS
  const next: CaffeineSettings = { ...current, ...patch }
  db.insert(settings)
    .values({ id: SETTINGS_ROW_ID, caffeine: next, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: settings.id,
      set: { caffeine: next, updatedAt: Date.now() },
    })
    .run()
  return next
}

/** Persist the Start-from-template defaults without clobbering the other choice. */
export function writeProjectTemplateSettings(
  db: PiLabDatabase,
  patch: Partial<ProjectTemplateSettings>,
): ProjectTemplateSettings {
  const current = getSettingsOrDefaults(db).projectTemplate
  const next: ProjectTemplateSettings = {
    initializationMarkdownFiles:
      patch.initializationMarkdownFiles ?? current.initializationMarkdownFiles,
    defaultTemplateParentPath: patch.defaultTemplateParentPath ?? current.defaultTemplateParentPath,
    projectTypes: patch.projectTypes ?? current.projectTypes,
  }
  const storedTypes =
    db
      .select({ projectTemplate: settings.projectTemplate })
      .from(settings)
      .where(eq(settings.id, SETTINGS_ROW_ID))
      .get()?.projectTemplate.projectTypes ?? []
  const retainedTypes = storedTypes.filter(
    (type) => !next.projectTypes.some((visible) => visible.id === type.id),
  )
  const storedNext = { ...next, projectTypes: [...next.projectTypes, ...retainedTypes] }
  db.insert(settings)
    .values({ id: SETTINGS_ROW_ID, projectTemplate: storedNext, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: settings.id,
      set: { projectTemplate: storedNext, updatedAt: Date.now() },
    })
    .run()
  return next
}

export const settingsRouter = router({
  /** The current settings row, or schema defaults when none has been persisted. */
  get: publicProcedure.query(({ ctx }): Settings & { agents: AgentSettings } => ({
    ...getSettingsOrDefaults(ctx.db),
    agents: getAgentSettingsOrDefaults(ctx.db),
  })),

  /**
   * Patch the built-in editor preferences. Returns the
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

  initializeDefaultAgent: publicProcedure
    .input(z.object({ agentId: z.string().trim().min(1) }))
    .mutation(({ ctx, input }): AgentSettings => {
      const current = getAgentSettingsOrDefaults(ctx.db)
      return current.defaultAgentId === null
        ? writeAgentSettings(ctx.db, { defaultAgentId: input.agentId })
        : current
    }),

  updateAgents: publicProcedure
    .input(agentsPatch)
    .mutation(({ ctx, input }): AgentSettings => writeAgentSettings(ctx.db, input)),

  /** Patch Start-from-template defaults (relative template Markdown paths + parent folder). */
  updateProjectTemplate: publicProcedure
    .input(projectTemplatePatch)
    .mutation(
      ({ ctx, input }): ProjectTemplateSettings => writeProjectTemplateSettings(ctx.db, input),
    ),

  /** Save editable guidance for one built-in project type. */
  updateProjectTypeGuidance: publicProcedure
    .input(projectTypeGuidanceInput)
    .mutation(({ ctx, input }): ProjectType => {
      const current = getSettingsOrDefaults(ctx.db).projectTemplate.projectTypes
      const existing = current.find((type) => type.id === input.id)
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Project type not found" })
      const saved = { ...existing, guidance: input.guidance }
      const projectTypes = current.map((type) => (type.id === input.id ? saved : type))
      writeProjectTemplateSettings(ctx.db, { projectTypes })
      return saved
    }),

  /**
   * Patch global notification mute, per-event enablement, and bundled sound
   * choices. Returns the full persisted notification group.
   */
  updateNotifications: publicProcedure
    .input(notificationsPatch)
    .mutation(({ ctx, input }): NotificationSettings => writeNotificationSettings(ctx.db, input)),
})
