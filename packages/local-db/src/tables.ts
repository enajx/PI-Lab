import { randomUUID } from "node:crypto"
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

/**
 * Skipper's local store. Every row lives on the user's own machine in
 * `$SKIPPER_DATA_DIR/local.db` — there is no cloud mirror, no synced identity,
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

/** Lifecycle of a single automation firing (launch-only; no completion tracking). */
export type AutomationRunState = "pending" | "launched" | "failed"

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

/** A locally-known v2 Team (names only — no remote ids, see docs/architecture.md (local DB)). */
export interface KnownTeam {
  name: string
  color?: string
}

/**
 * Built-in editor preferences (AGENTS.md "Scope", TODO "Built-in editor" — "Editor
 * settings group"). Persisted as a JSON blob on the singleton `settings` row so
 * the whole group travels as one column and gains new keys without a migration.
 * Every field is local-only and has a default that matches the spec ("off by
 * default" for the toggles; `ty` as the default type checker).
 */
export interface EditorSettings {
  /** Save on debounce/blur instead of requiring an explicit ⌘S (default off). */
  autosave: boolean
  /** Enable the CodeMirror Vim keymap (default off). */
  vim: boolean
  /** Which Python type checker the diagnostics run uses (default `ty`). */
  typeChecker: "ty" | "pyrefly"
  /** Run `ruff format` on ⌘S, then reload the buffer (default off). */
  formatOnSave: boolean
  /**
   * Stored id of the editor color theme (default `"default"` — the editor's
   * built-in highlighting). Kept a plain string so the DB never couples to the
   * renderer's theme registry; the renderer resolves it to a CodeMirror extension
   * and treats an unknown/legacy id as the default.
   */
  editorTheme: string
}

/** Spec defaults for {@link EditorSettings} (TODO "Built-in editor"). */
export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  autosave: false,
  vim: false,
  typeChecker: "ty",
  formatOnSave: false,
  editorTheme: "default",
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
   * Worktree policy for the "start agent session" flow (docs/architecture.md (agent runtime)). When ON,
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
    /** Failure detail when `state = "failed"`. */
    error: text("error"),
    createdAt: createdNow(),
    launchedAt: integer("launched_at"),
  },
  (t) => [
    index("ix_automation_runs_automation").on(t.automationId, t.createdAt),
    index("ix_automation_runs_workspace").on(t.workspaceId),
    // One run per scheduled occurrence: the scheduler's overlap/double-fire guard
    // claims an occurrence by inserting a run with `onConflictDoNothing` against
    // this index, so a slow/overlapping tick can't fire the same instant twice.
    uniqueIndex("ux_automation_run_occurrence").on(t.automationId, t.scheduledFor),
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
export type AutomationPromptVersion = typeof automationPromptVersions.$inferSelect
export type NewAutomationPromptVersion = typeof automationPromptVersions.$inferInsert
