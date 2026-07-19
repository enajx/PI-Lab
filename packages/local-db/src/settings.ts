import { eq } from "drizzle-orm"
import type { PiLabDatabase } from "./index"
import {
  type AgentSettings,
  agentSettings,
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_CAFFEINE_SETTINGS,
  DEFAULT_EDITOR_SETTINGS,
  DEFAULT_NOTIFICATION_SETTINGS,
  type EditorSettings,
  type Settings,
  settings,
} from "./tables"

/**
 * The `settings` table holds exactly one row, pinned to id=1 (see `tables.ts`).
 * A fresh database has no row at all until something first writes one, so every
 * reader needs a single source of truth for "the current settings, or the
 * schema defaults if none has been persisted yet".
 *
 * {@link getSettingsOrDefaults} is that source: it reads row 1 and, when absent,
 * returns the same default shape Drizzle would insert. It performs no write — a
 * pure read so it is safe to call from anywhere (including read-only flows like
 * the start-agent-session policy in md/engineering/architecture.md (agent runtime)). The returned object is a
 * fully-typed {@link Settings} row regardless of whether one exists on disk.
 */

/** The fixed primary key of the singleton settings row. */
export const SETTINGS_ROW_ID = 1

/**
 * Schema-aligned defaults for a settings row that has never been persisted.
 * Kept in lockstep with the column defaults declared in `tables.ts`; `updatedAt`
 * is stamped at read time so callers always see a concrete instant.
 */
function defaultSettings(): Settings {
  return {
    id: SETTINGS_ROW_ID,
    theme: "system",
    editorFontFamily: null,
    editorFontSize: null,
    terminalFontFamily: null,
    terminalFontSize: null,
    agentPresets: [],
    confirmOnQuit: true,
    knownTeams: [],
    worktreePerAgent: false,
    editor: DEFAULT_EDITOR_SETTINGS,
    notifications: DEFAULT_NOTIFICATION_SETTINGS,
    caffeine: DEFAULT_CAFFEINE_SETTINGS,
    zotero: null,
    updatedAt: Date.now(),
  }
}

/**
 * JSON settings do not receive SQL column migrations when a new event is
 * introduced. Merge every nested event with current defaults so rows written by
 * older PI Lab versions immediately gain new notification choices.
 */
function notificationSettingsWithDefaults(
  stored: Partial<Settings["notifications"]> | null | undefined,
): Settings["notifications"] {
  return {
    muted: stored?.muted ?? DEFAULT_NOTIFICATION_SETTINGS.muted,
    agentInput: {
      ...DEFAULT_NOTIFICATION_SETTINGS.agentInput,
      ...stored?.agentInput,
    },
    agentTurnCompletion: {
      ...DEFAULT_NOTIFICATION_SETTINGS.agentTurnCompletion,
      ...stored?.agentTurnCompletion,
    },
    terminalCompletion: {
      ...DEFAULT_NOTIFICATION_SETTINGS.terminalCompletion,
      ...stored?.terminalCompletion,
    },
    workflowStart: {
      ...DEFAULT_NOTIFICATION_SETTINGS.workflowStart,
      ...stored?.workflowStart,
    },
    workflowCompletion: {
      ...DEFAULT_NOTIFICATION_SETTINGS.workflowCompletion,
      ...stored?.workflowCompletion,
    },
    workflowFailure: {
      ...DEFAULT_NOTIFICATION_SETTINGS.workflowFailure,
      ...stored?.workflowFailure,
    },
  }
}

/**
 * Editor preferences also live in one JSON column, so rows written before a new
 * preference was introduced need the same read-time defaulting as notifications.
 */
function editorSettingsWithDefaults(
  stored: Partial<EditorSettings> | null | undefined,
): EditorSettings {
  return {
    ...DEFAULT_EDITOR_SETTINGS,
    ...stored,
  }
}

/**
 * Read the singleton settings row, falling back to schema defaults when the
 * database has no row yet. Never writes.
 */
export function getSettingsOrDefaults(db: PiLabDatabase): Settings {
  const row = db.select().from(settings).where(eq(settings.id, SETTINGS_ROW_ID)).get()
  if (!row) return defaultSettings()
  return {
    ...row,
    editor: editorSettingsWithDefaults(row.editor),
    notifications: notificationSettingsWithDefaults(row.notifications),
  }
}

export function getAgentSettingsOrDefaults(db: PiLabDatabase): AgentSettings {
  const row = db.select().from(agentSettings).where(eq(agentSettings.id, SETTINGS_ROW_ID)).get()
  if (!row) return DEFAULT_AGENT_SETTINGS
  return {
    projectConfigStorage: row.projectConfigStorage,
    executableOverrides: row.executableOverrides,
    setupCompleted: row.setupCompleted,
  }
}
