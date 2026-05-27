import { randomUUID } from "node:crypto"
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

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

/** A locally-known v2 Team (names only — no remote ids, see AGENTS.md §5). */
export interface KnownTeam {
  name: string
  color?: string
}

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
  /** Locally-known v2 Teams (names/colors only — no remote identity). */
  knownTeams: text("known_teams", { mode: "json" }).notNull().$type<KnownTeam[]>().default([]),
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
export type Automation = typeof automations.$inferSelect
export type NewAutomation = typeof automations.$inferInsert
export type AutomationRun = typeof automationRuns.$inferSelect
export type NewAutomationRun = typeof automationRuns.$inferInsert
export type AutomationPromptVersion = typeof automationPromptVersions.$inferSelect
export type NewAutomationPromptVersion = typeof automationPromptVersions.$inferInsert
