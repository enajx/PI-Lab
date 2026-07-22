import { randomUUID } from "node:crypto"
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { DEFAULT_EDITOR_SETTINGS, type EditorSettings } from "./editorSettings"

export { DEFAULT_EDITOR_SETTINGS, type EditorSettings } from "./editorSettings"

/**
 * PI Lab's local store. Every row lives on the user's own machine in
 * `$PI_LAB_DATA_DIR/local.db` — there is no cloud mirror, no synced identity,
 * and no remote ownership. The shape below models exactly four things:
 *
 *   1. the user's research units      -> `projects`
 *   2. the git checkouts under them   -> `worktrees`
 *   3. the agent/editing contexts     -> `workspaces` (+ `workspaceSections`)
 *   4. unattended agent schedules     -> `automations` (+ runs / prompt history)
 *
 * plus two singletons of convenience: app-wide `settings` and in-app browser
 * `browserHistory`.
 *
 * Conventions used throughout:
 *   - Text UUID v4 primary keys, minted in JS so inserts never round-trip.
 *   - Epoch-millisecond integers for every instant (`*At` suffix).
 *   - camelCase property names; explicit snake_case SQL column names.
 *   - JSON columns are typed via `$type<>()` and parsed by drizzle.
 */

/** Fresh UUID v4 primary key, generated app-side (no DB extension needed). */
const primaryId = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID())

/** Epoch-millisecond instant that defaults to insert time. */
const createdNow = () =>
  integer("created_at")
    .notNull()
    .$defaultFn(() => Date.now())

// ---------------------------------------------------------------------------
// Domain unions (kept beside their tables; columns reference them via $type).
// ---------------------------------------------------------------------------

/**
 * How a workspace is rooted in git:
 *   - "worktree": its own isolated checkout (rows in `worktrees`).
 *   - "branch":   the project's primary checkout, on a named branch. At most one
 *                 of these may exist per project (see the partial unique index
 *                 added in migration 0001 — Drizzle can't express filtered
 *                 indexes in the schema DSL).
 */
export type WorkspaceKind = "worktree" | "branch"

/**
 * Lifecycle of a single automation firing.
 *
 * `launched` is retained for rows written by older PI Lab versions. New
 * interactive and run-to-completion workflows advance through `pending` →
 * `running` → `completed`/`failed`.
 */
export type AutomationRunState = "pending" | "launched" | "running" | "completed" | "failed"

/** How a workflow invokes its selected harness. */
export type AutomationExecutionMode = "interactive" | "noninteractive"

/** Current lifecycle classification for a durable interactive agent session. */
export type AgentSessionState = "working" | "waiting" | "exited"

/** Why a live interactive agent is waiting for the user. */
export type AgentSessionWaitingReason =
  | "initial-prompt"
  | "permission"
  | "question"
  | "turn-complete"
  | "idle"

/** Bundled notification sound, or no custom sound playback. */
export type NotificationSound = "chime" | "pulse" | "success" | "alert" | "silent"

/** Enablement and sound choice for one notification event. */
export interface NotificationEventSettings {
  enabled: boolean
  sound: NotificationSound
}

/** App-wide notification preferences persisted on the singleton settings row. */
export interface NotificationSettings {
  /** Suppress all native banners and custom sounds. */
  muted: boolean
  /** Interactive agent needs permission, an answer, or a new instruction. */
  agentInput: NotificationEventSettings
  /** An armed interactive agent turn returned to its normal input prompt. */
  agentTurnCompletion: NotificationEventSettings
  /** A submitted command in a project terminal returned to its shell prompt. */
  terminalCompletion: NotificationEventSettings
  /** A workflow run entered its running state. */
  workflowStart: NotificationEventSettings
  /** A workflow run completed successfully. */
  workflowCompletion: NotificationEventSettings
  /** A workflow run failed to launch or terminated unsuccessfully. */
  workflowFailure: NotificationEventSettings
}

/** Defaults for a settings row that predates notification preferences. */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  muted: false,
  agentInput: { enabled: true, sound: "chime" },
  agentTurnCompletion: { enabled: true, sound: "success" },
  terminalCompletion: { enabled: true, sound: "success" },
  workflowStart: { enabled: false, sound: "pulse" },
  workflowCompletion: { enabled: true, sound: "success" },
  workflowFailure: { enabled: true, sound: "alert" },
}

/** User-selected caffeine behavior for Electron's power-save blocker. */
export type CaffeineMode = "off" | "on" | "auto"

/** Whether caffeine prevents app suspension only, or also keeps the display awake. */
export type CaffeineScope = "system-only" | "system-plus-display"

/** App-wide caffeine preferences persisted on the singleton settings row. */
export interface CaffeineSettings {
  mode: CaffeineMode
  scope: CaffeineScope
}

/** Conservative defaults: no blocker until the user opts in, system-only when enabled. */
export const DEFAULT_CAFFEINE_SETTINGS: CaffeineSettings = {
  mode: "off",
  scope: "system-only",
}

/** Origin of an automation prompt revision, for the version-history view. */
export type PromptRevisionOrigin = "edit" | "revert"

/** Per-agent launch preset, stored as JSON in `settings.agentPresets`. */
export interface AgentPreset {
  /** Stable id of the catalogued agent, e.g. "claude-code" or "codex". */
  agentId: string
  /** User-facing label for this preset. */
  label: string
  /** Argument vector appended to the agent's base command. */
  args?: string[]
  /** Extra environment variables injected when launching. */
  env?: Record<string, string>
  /** Default working subdirectory, relative to the workspace root. */
  cwd?: string
}

/** Where PI Lab persists project-specific launch choices. */
export type ProjectConfigStorage = "app" | "project" | "both"

/** App-wide agent launch and per-project config persistence preferences. */
export interface AgentSettings {
  projectConfigStorage: ProjectConfigStorage
  /** Explicit executable paths keyed by catalog agent id. */
  executableOverrides: Record<string, string>
  /** Whether the user has completed or skipped the first-run setup flow. */
  setupCompleted: boolean
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  projectConfigStorage: "app",
  executableOverrides: {},
  setupCompleted: false,
}

/** PI Lab-owned keys stored per project, either in SQLite or `.pi-lab/config.json`. */
export interface ProjectAgentConfig {
  agentId?: string
}

/**
 * A project's persisted dashboard-card gradient. The card's noisy-gradient artwork
 * is re-derived from these on every launch, so it stays identical across restarts.
 * `seed` drives the `mulberry32` PRNG in `@pi-lab/ui`'s gradient-patterns generator;
 * `palette` is the exact list of colors it was sampled with (captured from the app
 * theme at generation time), frozen here so a later theme change never alters an
 * existing project's gradient. Null ⇒ no gradient captured yet (the card samples one
 * from the current theme on first render and persists it).
 */
export interface ProjectGradient {
  seed: number
  palette: string[]
}

/** One reference link on a project card: a URL, optionally given a display label. */
export interface ProjectReferenceLink {
  url: string
  label?: string
}

/**
 * Extra, user-entered project metadata edited via the card's "Edit project…"
 * dialog and surfaced under the card title. Every field is optional; only the
 * fields the user actually filled render on the card (empty fields show nothing).
 * Stored as one JSON blob (like {@link ProjectGradient}) so the group can grow
 * without another migration. Null / an all-empty object ⇒ nothing to show.
 */
export interface ProjectMetadata {
  /** Free-text collaborators (e.g. co-authors), as typed by the user. */
  collaborators?: string
  /** Target publishing venue (journal, conference, etc.). */
  venue?: string
  /** Deadline as an ISO date string (`YYYY-MM-DD`, from an `<input type="date">`). */
  deadline?: string
  /** A small set of chosen emoji tags. */
  emojiTags?: string[]
  /** Reference links, each a URL with an optional label. */
  referenceLinks?: ProjectReferenceLink[]
}

/** A locally-known v2 Team (names only — no remote ids, see md/engineering/architecture.md (local DB)). */
export interface KnownTeam {
  name: string
  color?: string
}

/** Personal-library id for local (zero-config) mode: `/users/0`. */
export const LOCAL_LIBRARY_ID = "0" as const

/** Which library a Zotero source addresses, shared by both Zotero modes. */
interface ZoteroLibraryRef {
  /** Whether `libraryId` addresses a personal ("user") or shared ("group") library. */
  libraryType: "user" | "group"
  /** Numeric Zotero library id, as a string (used verbatim in the API path; "0" = local personal). */
  libraryId: string
}

/**
 * Local Zotero desktop reachable at `http://localhost:23119/api` — the
 * same v3 read API, served from the on-disk database, no API key. Reads need only
 * the app running; writes additionally need {@link ZoteroLocalSource.bridgeToken}.
 */
export interface ZoteroLocalSource extends ZoteroLibraryRef {
  kind: "zotero"
  mode: "local"
  /**
   * Debug-bridge token (`extensions.zotero.debug-bridge.token` in Zotero's Config
   * Editor) — required for WRITES only (it authorizes privileged JS execution on
   * localhost). Absent ⇒ reads work, file attachment is disabled. Never logged.
   */
  bridgeToken?: string
}

/**
 * Zotero Web API (`https://api.zotero.org`) — the cloud library, keyed by a personal
 * API key. Works without the desktop app; writes need a key with library write access.
 */
export interface ZoteroWebSource extends ZoteroLibraryRef {
  kind: "zotero"
  mode: "web"
  /** Personal Zotero Web API key (zotero.org/settings/keys). Never logged or synced. */
  apiKey: string
}

/**
 * A plain local folder of papers (no Zotero) — for researchers who keep PDFs in a
 * directory tree. Subfolders are browsed as collections, `.pdf` files as items. Read
 * only (no attach). `folderPath` is absolute and is validated to exist on connect.
 */
export interface FolderSource {
  kind: "folder"
  folderPath: string
}

/** The two Zotero-backed sources, narrowed for the Zotero-only read/write helpers. */
export type ZoteroSource = ZoteroLocalSource | ZoteroWebSource

/**
 * Stored Library source for the Library science tab (AGENTS.md "Scope" "Science tabs").
 * Persisted in the singleton `settings` row as a JSON blob (still in the historically
 * named `zotero` column), local-only like everything else — any credentials live on the
 * user's machine and are never logged or synced. `null` (the column default) means "not
 * connected". `kind` discriminates Zotero from a local folder; within Zotero, `mode`
 * discriminates the local desktop API from the cloud Web API.
 */
export type LibrarySource = ZoteroSource | FolderSource

/**
 * Normalize a persisted source blob to {@link LibrarySource}. Folder rows carry
 * `kind: "folder"` + a `folderPath`. Everything else is Zotero: rows written before
 * `kind`/`mode` existed have neither and always carried an `apiKey`, so they coerce to
 * Zotero web; `mode: "local"` rows coerce to Zotero local (defaulting to `/users/0`).
 * Returns `null` for null/garbage so callers treat it as "not connected". Read-time
 * coercion only — there is no migration.
 */
export function coerceLibrarySource(raw: unknown): LibrarySource | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>

  // Folder source: explicit `kind`, or a bare `folderPath` with no Zotero markers.
  if (
    r.kind === "folder" ||
    (typeof r.folderPath === "string" && r.mode == null && r.apiKey == null)
  ) {
    return typeof r.folderPath === "string" && r.folderPath.trim().length > 0
      ? { kind: "folder", folderPath: r.folderPath }
      : null
  }

  // Otherwise Zotero (explicit `kind: "zotero"` or a legacy row predating `kind`).
  const libraryType = r.libraryType === "group" ? "group" : "user"
  const libraryId = typeof r.libraryId === "string" ? r.libraryId : ""
  if (r.mode === "local") {
    return {
      kind: "zotero",
      mode: "local",
      libraryType,
      libraryId: libraryId || LOCAL_LIBRARY_ID,
      ...(typeof r.bridgeToken === "string" && r.bridgeToken.length > 0
        ? { bridgeToken: r.bridgeToken }
        : {}),
    }
  }
  // Explicit "web", or a legacy row (no `mode`) that carried an apiKey. Both a key
  // and a library id are required — a row missing either is treated as not connected.
  if (typeof r.apiKey === "string" && r.apiKey.length > 0 && libraryId.length > 0) {
    return { kind: "zotero", mode: "web", apiKey: r.apiKey, libraryType, libraryId }
  }
  return null
}

/**
 * Where a monitored machine came from:
 *   - "ssh-config": imported from the user's OpenSSH client config (one row per
 *                   concrete Host alias). Re-importing refreshes these in place.
 *   - "manual":     hand-added in the Cluster tab for a box that isn't (or isn't
 *                   yet) in `~/.ssh/config`.
 */
export type MachineSource = "ssh-config" | "manual"

// ---------------------------------------------------------------------------
// projects — a local git repo opened as a research unit.
// ---------------------------------------------------------------------------

export const projects = sqliteTable(
  "projects",
  {
    id: primaryId(),
    /** Absolute path to the repository's primary working tree. */
    repoPath: text("repo_path").notNull().unique(),
    /** Display name (defaults to the repo folder name on import). */
    name: text("name").notNull(),
    /** Default git branch, e.g. "main" — null until first resolved. */
    defaultBranch: text("default_branch"),
    /** Accent color for cards / sidebar (hex or token name). */
    color: text("color"),
    /**
     * Dashboard card header image, stored as a self-contained `data:` URL (the
     * user drag-and-drops an image onto the card). Null ⇒ the card falls back to
     * a deterministic gradient seeded from the project id (md/02 — "Dashboard &
     * project cards"). Kept inline rather than as a file path so the thumbnail
     * travels with the row and never dangles.
     */
    thumbnail: text("thumbnail"),
    /**
     * Persisted dashboard-card gradient (`{ seed, palette }`), captured from the app
     * theme when the gradient is generated and frozen so it survives restarts and later
     * theme changes ({@link ProjectGradient}). Null ⇒ none captured yet (the card samples
     * one on first render). Mutually exclusive with {@link projects.thumbnail} in the UI:
     * setting a thumbnail nulls this, generating a gradient nulls the thumbnail.
     */
    gradient: text("gradient", { mode: "json" }).$type<ProjectGradient>(),
    /**
     * Extra user-entered project metadata (collaborators, publishing venue,
     * deadline, emoji tags, reference links) edited via the card's "Edit project…"
     * dialog and shown under the card title ({@link ProjectMetadata}). One JSON blob
     * so the field group grows without a migration; null ⇒ none entered yet.
     */
    metadata: text("metadata", { mode: "json" }).$type<ProjectMetadata>(),
    /** App-memory copy of project-specific agent choices. */
    agentConfig: text("agent_config", { mode: "json" }).$type<ProjectAgentConfig>(),
    /** Manual ordering in the sidebar; lower sorts first. */
    sortIndex: integer("sort_index").notNull().default(0),
    /** Archived projects are hidden from the active list but never deleted. */
    archivedAt: integer("archived_at"),
    createdAt: createdNow(),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    /** Last time the user focused this project (drives "recent" ordering). */
    lastOpenedAt: integer("last_opened_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    index("ix_projects_sort").on(t.sortIndex),
    index("ix_projects_last_opened").on(t.lastOpenedAt),
    index("ix_projects_archived").on(t.archivedAt),
  ],
)

// ---------------------------------------------------------------------------
// worktrees — an on-disk isolated git checkout belonging to a project.
// ---------------------------------------------------------------------------

export const worktrees = sqliteTable(
  "worktrees",
  {
    id: primaryId(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Absolute path of the checkout on disk. */
    path: text("path").notNull().unique(),
    /** Branch checked out in this worktree. */
    branch: text("branch").notNull(),
    /** Branch this worktree was forked from, when known. */
    baseBranch: text("base_branch"),
    createdAt: createdNow(),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [index("ix_worktrees_project").on(t.projectId), index("ix_worktrees_branch").on(t.branch)],
)

// ---------------------------------------------------------------------------
// workspaceSections — user-defined grouping of workspaces within a project.
// (Declared before `workspaces` so the FK target resolves cleanly.)
// ---------------------------------------------------------------------------

export const workspaceSections = sqliteTable(
  "workspace_sections",
  {
    id: primaryId(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Manual ordering of sections within the project. */
    sortIndex: integer("sort_index").notNull().default(0),
    /** Whether the group is collapsed in the sidebar. */
    collapsed: integer("collapsed", { mode: "boolean" }).notNull().default(false),
    color: text("color"),
    createdAt: createdNow(),
  },
  (t) => [index("ix_workspace_sections_project").on(t.projectId)],
)

// ---------------------------------------------------------------------------
// workspaces — an agent/editing context in a project, backed by a worktree or
// the project's primary branch.
// ---------------------------------------------------------------------------

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: primaryId(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Set only when `kind = "worktree"`; null for branch-backed workspaces. */
    worktreeId: text("worktree_id").references(() => worktrees.id, {
      onDelete: "cascade",
    }),
    /** Optional group this workspace belongs to. */
    sectionId: text("section_id").references(() => workspaceSections.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull().$type<WorkspaceKind>(),
    name: text("name").notNull(),
    /** Branch this workspace operates on. */
    branch: text("branch").notNull(),
    /** Base of a contiguous port range reserved for this workspace's dev servers. */
    portBase: integer("port_base"),
    /**
     * User-selected Python environment directory or interpreter. Null keeps
     * workspace-scoped automatic detection active.
     */
    pythonEnvironmentPath: text("python_environment_path"),
    /** Manual ordering within its project / section. */
    sortIndex: integer("sort_index").notNull().default(0),
    createdAt: createdNow(),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    /** Last time an agent/terminal was active here (drives "recent"). */
    lastActiveAt: integer("last_active_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    index("ix_workspaces_project").on(t.projectId),
    index("ix_workspaces_worktree").on(t.worktreeId),
    index("ix_workspaces_section").on(t.sectionId),
    index("ix_workspaces_last_active").on(t.lastActiveAt),
    // NB: a partial unique index enforcing "one branch-kind workspace per
    // project" is added in migration 0001 — Drizzle's DSL cannot express a
    // filtered (WHERE) index, so it is not declared here.
  ],
)

// ---------------------------------------------------------------------------
// settings — single global app-config row (id is pinned to 1).
// ---------------------------------------------------------------------------

export const settings = sqliteTable("settings", {
  /** Always 1: this table holds exactly one row. */
  id: integer("id").primaryKey().default(1),
  /** "dark" | "light" | "system" — kept as free text for forward-compat. */
  theme: text("theme").notNull().default("system"),
  editorFontFamily: text("editor_font_family"),
  editorFontSize: integer("editor_font_size"),
  terminalFontFamily: text("terminal_font_family"),
  terminalFontSize: integer("terminal_font_size"),
  /** Per-agent launch presets. */
  agentPresets: text("agent_presets", { mode: "json" })
    .notNull()
    .$type<AgentPreset[]>()
    .default([]),
  /** Whether to prompt before quitting with live sessions. */
  confirmOnQuit: integer("confirm_on_quit", { mode: "boolean" }).notNull().default(true),
  /**
   * Worktree policy for the "start agent session" flow (md/engineering/architecture.md (agent runtime)). When ON,
   * every agent session gets its own fresh git worktree. When OFF (default), an
   * agent opens in the project's main checkout (its single branch workspace) and
   * only spills into a fresh worktree once a second concurrent agent would
   * otherwise clobber that shared checkout.
   */
  worktreePerAgent: integer("worktree_per_agent", { mode: "boolean" }).notNull().default(false),
  /**
   * Built-in editor preferences (autosave / vim / type checker / format-on-save),
   * stored as a JSON blob so the group grows without a migration (AGENTS.md "Scope",
   * TODO "Built-in editor"). Defaults to the spec's all-off / `ty` shape.
   */
  editor: text("editor", { mode: "json" })
    .notNull()
    .$type<EditorSettings>()
    .default(DEFAULT_EDITOR_SETTINGS),
  /**
   * Native notification and renderer sound preferences. Stored as one JSON
   * group so adding an event in a later release does not require another
   * migration.
   */
  notifications: text("notifications", { mode: "json" })
    .notNull()
    .$type<NotificationSettings>()
    .default(DEFAULT_NOTIFICATION_SETTINGS),
  /**
   * Persisted caffeine mode and power-save blocker scope. The controller reads
   * this group during app startup and reconciles the live blocker.
   */
  caffeine: text("caffeine", { mode: "json" })
    .notNull()
    .$type<CaffeineSettings>()
    .default(DEFAULT_CAFFEINE_SETTINGS),
  /** Locally-known v2 Teams (names/colors only — no remote identity). */
  knownTeams: text("known_teams", { mode: "json" }).notNull().$type<KnownTeam[]>().default([]),
  /**
   * Stored Library source for the Library science tab — a Zotero connection (local
   * desktop API or cloud Web API) or a local folder of PDFs (see {@link LibrarySource})
   * — or `null` when not connected (AGENTS.md "Scope"). Local-only; credentials never
   * leave the machine or get logged. The column keeps its historical name `zotero`, but
   * holds any source. Freeform JSON, so the union widened (modes, then a folder kind)
   * without a migration — rows are normalized at read time by `coerceLibrarySource`.
   */
  zotero: text("zotero", { mode: "json" }).$type<LibrarySource>(),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => Date.now()),
})

// ---------------------------------------------------------------------------
// agentSettings — singleton launch/config preferences, split from `settings`
// so its lifecycle does not force unrelated JSON-default table rebuilds.
// ---------------------------------------------------------------------------

export const agentSettings = sqliteTable("agent_settings", {
  id: integer("id").primaryKey().default(1),
  projectConfigStorage: text("project_config_storage")
    .notNull()
    .$type<ProjectConfigStorage>()
    .default("app"),
  executableOverrides: text("executable_overrides", { mode: "json" })
    .notNull()
    .$type<Record<string, string>>()
    .default({}),
  setupCompleted: integer("setup_completed", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => Date.now()),
})

/**
 * Encrypted, machine-local API credentials chosen during setup. The renderer
 * receives only presence state; ciphertext is produced by Electron safeStorage
 * in the main process and is never written to a project or exported config.
 */
export const agentCredentials = sqliteTable("agent_credentials", {
  agentId: text("agent_id").primaryKey(),
  encryptedValue: text("encrypted_value").notNull(),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => Date.now()),
})

// ---------------------------------------------------------------------------
// browserHistory — URL autocomplete for the in-app browser.
// ---------------------------------------------------------------------------

export const browserHistory = sqliteTable(
  "browser_history",
  {
    id: primaryId(),
    url: text("url").notNull().unique(),
    title: text("title").notNull().default(""),
    /** Total recorded visits (incremented on each navigation). */
    visitCount: integer("visit_count").notNull().default(1),
    visitedAt: integer("visited_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [index("ix_browser_history_visited").on(t.visitedAt)],
)

// ---------------------------------------------------------------------------
// machines — a remote compute box the user monitors from the Cluster science
// tab (AGENTS.md "Scope" "Science tabs"). v1 is *monitoring only*: rows are imported
// from `~/.ssh/config` or added by hand, annotated, hidden, and reachability-
// probed over the `ssh` CLI. Job dispatch / experiment runs are v2 and have no
// table here. Connection metadata only — never key material or secrets.
// ---------------------------------------------------------------------------

export const machines = sqliteTable(
  "machines",
  {
    id: primaryId(),
    /**
     * The ssh Host alias (for ssh-config rows) or the user-typed handle (for
     * manual rows). This is what the `ssh` CLI is invoked with, so it must round-
     * trip whatever the user already configured. Unique so a re-import upserts
     * rather than duplicates.
     */
    host: text("host").notNull().unique(),
    /** Resolved `HostName` from ssh config (the real address), when known. */
    hostname: text("hostname"),
    /** ssh login user (`User` directive), when set. */
    user: text("user"),
    /** ssh port (`Port` directive); null ⇒ ssh's own default (22). */
    port: integer("port"),
    source: text("source").notNull().$type<MachineSource>().default("manual"),
    /**
     * Hidden machines are filtered from the default Cluster list (ssh-config
     * often holds git hosts / jump boxes that aren't compute), never deleted —
     * surfaced again via the "Show hidden (N)" toggle.
     */
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    /** Free-text user annotation / display label (e.g. "8×A100 Slurm box"). */
    label: text("label"),
    /**
     * Last reachability result from a status probe: true/false once probed, null
     * before the first probe. Drives the status dot on the machine card.
     */
    reachable: integer("reachable", { mode: "boolean" }),
    /** When the last probe ran (epoch ms); null until first probed. */
    lastCheckedAt: integer("last_checked_at"),
    /** Probe detail — trimmed `uptime` output on success, error text on failure. */
    statusDetail: text("status_detail"),
    createdAt: createdNow(),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [index("ix_machines_hidden").on(t.hidden), index("ix_machines_source").on(t.source)],
)

// ---------------------------------------------------------------------------
// automations — a scheduled / looping agent run defined for a project.
// ---------------------------------------------------------------------------

export const automations = sqliteTable(
  "automations",
  {
    id: primaryId(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Catalogued agent id to launch (mirrors a workspace's chosen agent). */
    agentId: text("agent_id").notNull(),
    /**
     * Interactive opens a durable PTY session; non-interactive invokes the
     * harness once and owns lifecycle directly through process exit.
     */
    executionMode: text("execution_mode")
      .notNull()
      .$type<AutomationExecutionMode>()
      .default("interactive"),
    /** Current prompt body the agent is launched on. */
    prompt: text("prompt").notNull().default(""),
    /** RFC 5545 RRULE body (the recurrence rule, without DTSTART). */
    recurrenceRule: text("recurrence_rule").notNull(),
    /** Recurrence anchor (epoch ms). */
    startAt: integer("start_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    /** IANA timezone the schedule is evaluated in. */
    timezone: text("timezone").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** Next instant this should fire (epoch ms); null when off/exhausted. */
    nextRunAt: integer("next_run_at"),
    createdAt: createdNow(),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    index("ix_automations_project").on(t.projectId),
    // Drives the scheduler's "enabled & due" sweep.
    index("ix_automations_due").on(t.enabled, t.nextRunAt),
  ],
)

// ---------------------------------------------------------------------------
// automationRuns — the execution log; one row per firing.
// ---------------------------------------------------------------------------

export const automationRuns = sqliteTable(
  "automation_runs",
  {
    id: primaryId(),
    automationId: text("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    /** The scheduled instant this run covers (epoch ms). */
    scheduledFor: integer("scheduled_for").notNull(),
    state: text("state").notNull().$type<AutomationRunState>().default("pending"),
    /** Workspace/session spun up on launch (null until launched). */
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    /**
     * PTY-daemon session targeted by this interactive run. Deliberately not a
     * foreign key: the daemon id must remain readable on historical rows even
     * when its durable session record is cleaned up.
     */
    sessionId: text("session_id"),
    /** Failure detail when `state = "failed"`. */
    error: text("error"),
    createdAt: createdNow(),
    launchedAt: integer("launched_at"),
    completedAt: integer("completed_at"),
  },
  (t) => [
    index("ix_automation_runs_automation").on(t.automationId, t.createdAt),
    index("ix_automation_runs_workspace").on(t.workspaceId),
    index("ix_automation_runs_session").on(t.sessionId),
    // One run per scheduled occurrence: the scheduler's overlap/double-fire guard
    // claims an occurrence by inserting a run with `onConflictDoNothing` against
    // this index, so a slow/overlapping tick can't fire the same instant twice.
    uniqueIndex("ux_automation_run_occurrence").on(t.automationId, t.scheduledFor),
  ],
)

// ---------------------------------------------------------------------------
// projectWorkflowRuns — the last COMPLETED result of a non-interactive project
// workflow (the "Project summary" and "Fetch remote experiments" background
// tasks). One row per (project, task): the run's captured output, the git-state
// hash it was computed against (the cache/re-run trigger), when it was last
// checked, and a failure message when the run errored/timed out. Only completed
// results live here — "currently running" is tracked in-memory (nothing is
// running on startup), never persisted.
// ---------------------------------------------------------------------------

/** A non-interactive project workflow with a cached, per-project result. */
export type WorkflowTask = "summary" | "fetch-experiments"

export const projectWorkflowRuns = sqliteTable(
  "project_workflow_runs",
  {
    id: primaryId(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Which background workflow this row caches ({@link WorkflowTask}). */
    task: text("task").notNull().$type<WorkflowTask>(),
    /** The run's captured user-facing output (trimmed stdout); "" when none printed. */
    result: text("result").notNull().default(""),
    /**
     * The git-state hash the result was computed against (sha256 of HEAD +
     * `status --porcelain` + `diff HEAD`). A run request re-runs only when the
     * current hash differs; an identical hash returns this cached result.
     */
    inputHash: text("input_hash").notNull().default(""),
    /** When this result was last (re-)computed or re-checked (epoch ms). */
    lastCheckedAt: integer("last_checked_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    /** Failure detail when the last run errored/timed out; null on success. */
    errorMessage: text("error_message"),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    uniqueIndex("ux_project_workflow_runs_project_task").on(t.projectId, t.task),
    index("ix_project_workflow_runs_project").on(t.projectId),
  ],
)

// ---------------------------------------------------------------------------
// agentSessions — durable targeting and last-known lifecycle for interactive
// CLI agents. The app-lifetime activity registry owns the live classification;
// this table lets main reconcile still-live PTY sessions after a restart.
// ---------------------------------------------------------------------------

export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    id: primaryId(),
    /** Stable PTY-daemon session id used to attach/select the exact tab. */
    sessionId: text("session_id").notNull().unique(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    /** Catalogued interactive agent id, e.g. `claude-code` or `codex`. */
    agentId: text("agent_id").notNull(),
    /**
     * Interactive workflow run that initially launched this session, if any.
     * The inverse run → daemon-session target is plain indexed text, avoiding a
     * foreign-key cycle while preserving exact navigation in both directions.
     */
    workflowRunId: text("workflow_run_id").references(() => automationRuns.id, {
      onDelete: "set null",
    }),
    state: text("state").notNull().$type<AgentSessionState>().default("working"),
    /**
     * Whether a real user/launch prompt has armed the current turn. Persisted so
     * restart reconciliation cannot mistake an initial blank prompt for a
     * completed turn or lose a submitted turn that is still running.
     */
    turnArmed: integer("turn_armed", { mode: "boolean" }).notNull().default(false),
    waitingReason: text("waiting_reason").$type<AgentSessionWaitingReason>(),
    waitingSince: integer("waiting_since"),
    exitedAt: integer("exited_at"),
    createdAt: createdNow(),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    index("ix_agent_sessions_project").on(t.projectId),
    index("ix_agent_sessions_workspace").on(t.workspaceId),
    index("ix_agent_sessions_workflow_run").on(t.workflowRunId),
    index("ix_agent_sessions_state").on(t.state),
  ],
)

// ---------------------------------------------------------------------------
// automationPromptVersions — prompt revision history for an automation.
// ---------------------------------------------------------------------------

export const automationPromptVersions = sqliteTable(
  "automation_prompt_versions",
  {
    id: primaryId(),
    automationId: text("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    /** The prompt body captured by this revision. */
    prompt: text("prompt").notNull(),
    origin: text("origin").notNull().$type<PromptRevisionOrigin>().default("edit"),
    createdAt: createdNow(),
  },
  (t) => [index("ix_prompt_versions_automation").on(t.automationId, t.createdAt)],
)

// ---------------------------------------------------------------------------
// Row type aliases — inferred from the tables above.
// ---------------------------------------------------------------------------

export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert
export type Worktree = typeof worktrees.$inferSelect
export type NewWorktree = typeof worktrees.$inferInsert
export type Workspace = typeof workspaces.$inferSelect
export type NewWorkspace = typeof workspaces.$inferInsert
export type WorkspaceSection = typeof workspaceSections.$inferSelect
export type NewWorkspaceSection = typeof workspaceSections.$inferInsert
export type Settings = typeof settings.$inferSelect
export type NewSettings = typeof settings.$inferInsert
export type BrowserHistoryEntry = typeof browserHistory.$inferSelect
export type NewBrowserHistoryEntry = typeof browserHistory.$inferInsert
export type Machine = typeof machines.$inferSelect
export type NewMachine = typeof machines.$inferInsert
export type Automation = typeof automations.$inferSelect
export type NewAutomation = typeof automations.$inferInsert
export type AutomationRun = typeof automationRuns.$inferSelect
export type NewAutomationRun = typeof automationRuns.$inferInsert
export type AgentSession = typeof agentSessions.$inferSelect
export type NewAgentSession = typeof agentSessions.$inferInsert
export type AutomationPromptVersion = typeof automationPromptVersions.$inferSelect
export type NewAutomationPromptVersion = typeof automationPromptVersions.$inferInsert
export type ProjectWorkflowRun = typeof projectWorkflowRuns.$inferSelect
export type NewProjectWorkflowRun = typeof projectWorkflowRuns.$inferInsert
