import { DEFAULT_AGENT_ID } from "@pi-lab/shared/agents/catalog"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"
import { useTRPC } from "../trpc/react"

/**
 * Renderer-only user preferences (the local, layout/appearance kind) persisted to
 * `localStorage` — mirroring the existing `ThemeProvider` and shared card-grid
 * patterns. The DB `settings` table stays the home for anything the *main
 * process* needs (worktree policy, confirm-on-quit, editor diagnostics); these
 * are pure-UI toggles the renderer owns, so they live here with no migration.
 *
 * Each preference exposes a plain `read…()` (usable outside React — e.g. when
 * launching an agent) and a `use…()` hook (state + persistence) so the Settings
 * panel and the surfaces that consume the value share one source of truth.
 *
 * The hooks back onto a tiny module-level pub/sub via `useSyncExternalStore`, so
 * **every** instance of a hook for a given key re-renders when **any** of them
 * writes. Without this, a write in one component (e.g. the collapse toggle in
 * `_shell.tsx`) would update `localStorage` but never re-render a *different*
 * consumer (e.g. the `Sidebar`), and the change would silently not take effect.
 */

function persist(key: string, value: string): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Persistence is best-effort; a disabled/full localStorage just won't stick.
  }
}

// Module-level subscribers, keyed by preference key. A write emits to all of them.
const prefListeners = new Map<string, Set<() => void>>()

function subscribePref(key: string, callback: () => void): () => void {
  let set = prefListeners.get(key)
  if (!set) {
    set = new Set<() => void>()
    prefListeners.set(key, set)
  }
  set.add(callback)
  return () => {
    set?.delete(callback)
  }
}

function emitPref(key: string): void {
  const set = prefListeners.get(key)
  if (set) for (const callback of set) callback()
}

/** Persist a value under `key` and notify every hook instance watching it. */
function writePref(key: string, value: string): void {
  persist(key, value)
  emitPref(key)
}

function readBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback
  const raw = window.localStorage.getItem(key)
  return raw === null ? fallback : raw === "true"
}

function readNumber(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback
  const raw = window.localStorage.getItem(key)
  if (raw === null) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

function readString(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback
  const raw = window.localStorage.getItem(key)
  return raw === null ? fallback : raw
}

/** Shared boolean-preference hook: seeds from localStorage, persists + broadcasts on change. */
function useBooleanPref(key: string, fallback: boolean): [boolean, (next: boolean) => void] {
  const subscribe = useCallback((cb: () => void) => subscribePref(key, cb), [key])
  const getSnapshot = useCallback(() => readBoolean(key, fallback), [key, fallback])
  const value = useSyncExternalStore(subscribe, getSnapshot, () => fallback)
  const set = useCallback((next: boolean) => writePref(key, String(next)), [key])
  return [value, set]
}

const EDITOR_VIM_CACHE_KEY = "pi-lab.editor.vim"
const EDITOR_VIM_PENDING_KEY = "pi-lab.editor.vim.pending"

/** The quick renderer reads this without starting the full settings service. */
export const useEditorVimCache = (): [boolean, (next: boolean) => void] =>
  useBooleanPref(EDITOR_VIM_CACHE_KEY, false)

export function readEditorVimChoice(): boolean {
  return readBoolean(EDITOR_VIM_CACHE_KEY, false)
}

/** Mark a quick change for the full app to save in its editor settings. */
export function writeEditorVimChoice(value: boolean): void {
  writePref(EDITOR_VIM_CACHE_KEY, String(value))
  writePref(EDITOR_VIM_PENDING_KEY, "true")
}

export function editorVimChoicePending(): boolean {
  return readBoolean(EDITOR_VIM_PENDING_KEY, false)
}

/** Mirror the saved full-app choice after settings load or a successful save. */
export function settleEditorVimChoice(value: boolean): void {
  writePref(EDITOR_VIM_CACHE_KEY, String(value))
  writePref(EDITOR_VIM_PENDING_KEY, "false")
}

/** Quick Editor word suggestions use text in the current file and need no service. */
export const useQuickEditorAutocomplete = (): [boolean, (next: boolean) => void] =>
  useBooleanPref("pi-lab.quickEditor.autocomplete", false)

/** Python execution is optional so the quick renderer can start without its services. */
export const useQuickEditorRunPython = (): [boolean, (next: boolean) => void] =>
  useBooleanPref("pi-lab.quickEditor.runPython", false)

export type QuickEditorMarkdownMode = "source" | "render"

/** Default presentation for Markdown opened in Quick Editor. */
export const useQuickEditorMarkdownMode = (): [
  QuickEditorMarkdownMode,
  (next: QuickEditorMarkdownMode) => void,
] => {
  const [stored, setStored] = useStringPref("pi-lab.quickEditor.markdownMode", "source")
  return [stored === "render" ? "render" : "source", setStored]
}

/** Per-project dismissal state for the concise non-Git capability notice. */
export const useNonGitNoticeDismissed = (projectId: string): [boolean, (next: boolean) => void] =>
  useBooleanPref(`pi-lab.project.${projectId}.nonGitNoticeDismissed`, false)

export const dismissNonGitNotice = (projectId: string): void =>
  writePref(`pi-lab.project.${projectId}.nonGitNoticeDismissed`, "true")

/** Shared numeric-preference hook — same cross-instance sync semantics as the boolean one. */
function useNumberPref(key: string, fallback: number): [number, (next: number) => void] {
  const subscribe = useCallback((cb: () => void) => subscribePref(key, cb), [key])
  const getSnapshot = useCallback(() => readNumber(key, fallback), [key, fallback])
  const value = useSyncExternalStore(subscribe, getSnapshot, () => fallback)
  const set = useCallback((next: number) => writePref(key, String(next)), [key])
  return [value, set]
}

/** Shared string-preference hook — same cross-instance sync semantics as the boolean one. */
function useStringPref(key: string, fallback: string): [string, (next: string) => void] {
  const subscribe = useCallback((cb: () => void) => subscribePref(key, cb), [key])
  const getSnapshot = useCallback(() => readString(key, fallback), [key, fallback])
  const value = useSyncExternalStore(subscribe, getSnapshot, () => fallback)
  const set = useCallback((next: string) => writePref(key, next), [key])
  return [value, set]
}

/** The project last chosen in the LaTeX Editor tab ("" when none yet). */
export const useLatexEditorProject = (): [string, (next: string) => void] =>
  useStringPref("pi-lab.latexEditor.project", "")

/** The project last chosen in the Tasks tab ("" for All projects, the default). */
export const useTasksProject = (): [string, (next: string) => void] =>
  useStringPref("pi-lab.tasks.project", "")

/** The project last chosen in the Analysis tab ("" when none yet). */
export const useAnalysisProject = (): [string, (next: string) => void] =>
  useStringPref("pi-lab.analysis.project", "")

/** Whether the LaTeX Editor shows its left column (Files and Outline); hidden by default. */
export const useLatexEditorLeftColumn = (): [boolean, (next: boolean) => void] =>
  useBooleanPref("pi-lab.latexEditor.leftColumn", false)

/** Whether the LaTeX Editor's Outline section is expanded; open by default. */
export const useLatexEditorOutlineOpen = (): [boolean, (next: boolean) => void] =>
  useBooleanPref("pi-lab.latexEditor.outlineOpen", true)

/** Whether the LaTeX Editor's Files section is expanded; open by default. */
export const useLatexEditorFilesOpen = (): [boolean, (next: boolean) => void] =>
  useBooleanPref("pi-lab.latexEditor.filesOpen", true)

// --- Dashboard Digital Rain: global, renderer-only animation tuning --------
// These settings deliberately don't belong to a project: every card uses the
// same bounded rendering budget, while its character source remains project-owned.
export type DigitalRainDensity = "sparse" | "normal" | "dense"
export type DigitalRainSpeed = "slow" | "normal" | "fast"

const DIGITAL_RAIN_DENSITY_KEY = "pi-lab.digitalRain.density"
const DIGITAL_RAIN_SPEED_KEY = "pi-lab.digitalRain.speed"
const DIGITAL_RAIN_DENSITIES = new Set<DigitalRainDensity>(["sparse", "normal", "dense"])
const DIGITAL_RAIN_SPEEDS = new Set<DigitalRainSpeed>(["slow", "normal", "fast"])

export const useDigitalRainDensity = (): [
  DigitalRainDensity,
  (next: DigitalRainDensity) => void,
] => {
  const [stored, setStored] = useStringPref(DIGITAL_RAIN_DENSITY_KEY, "normal")
  const density = DIGITAL_RAIN_DENSITIES.has(stored as DigitalRainDensity)
    ? (stored as DigitalRainDensity)
    : "normal"
  return [density, setStored]
}

export const useDigitalRainSpeed = (): [DigitalRainSpeed, (next: DigitalRainSpeed) => void] => {
  const [stored, setStored] = useStringPref(DIGITAL_RAIN_SPEED_KEY, "normal")
  const speed = DIGITAL_RAIN_SPEEDS.has(stored as DigitalRainSpeed)
    ? (stored as DigitalRainSpeed)
    : "normal"
  return [speed, setStored]
}

// --- Project view: show the "Code changes" panel (hidden by default) ----------
const SHOW_CODE_CHANGES_KEY = "pi-lab.projectView.showCodeChanges"
export const readShowCodeChanges = (): boolean => readBoolean(SHOW_CODE_CHANGES_KEY, false)
export const useShowCodeChanges = (): [boolean, (next: boolean) => void] =>
  useBooleanPref(SHOW_CODE_CHANGES_KEY, false)

// --- Optional app sections: show/hide from Settings ---------------------------
// Cluster and Analysis are live surfaces, shown by default: their pref gates the sidebar nav row
// and guards the route. Experiments and Research Heartbeat have no surface yet, so
// Settings renders them as disabled, not-yet-available rows — their toggles are
// no-ops today (they never write), and the pref simply stays at its default until
// those sections ship (see the "Sections" settings section).
const SHOW_CLUSTER_SECTION_KEY = "pi-lab.sections.showCluster"
export const readShowClusterSection = (): boolean => readBoolean(SHOW_CLUSTER_SECTION_KEY, true)
export const useShowClusterSection = (): [boolean, (next: boolean) => void] =>
  useBooleanPref(SHOW_CLUSTER_SECTION_KEY, true)

const SHOW_ANALYSIS_SECTION_KEY = "pi-lab.sections.showAnalysis"
export const readShowAnalysisSection = (): boolean => readBoolean(SHOW_ANALYSIS_SECTION_KEY, true)
export const useShowAnalysisSection = (): [boolean, (next: boolean) => void] =>
  useBooleanPref(SHOW_ANALYSIS_SECTION_KEY, true)

// The Editor row is hidden by default; the sidebar also shows it while a file
// outside every project is open in the Editor. The /quick-edit route stays open
// either way (e.g. for "Open with PI Lab").
const SHOW_EDITOR_SECTION_KEY = "pi-lab.sections.showEditor"
export const useShowEditorSection = (): [boolean, (next: boolean) => void] =>
  useBooleanPref(SHOW_EDITOR_SECTION_KEY, false)

// --- Sidebar view entries: shown or hidden -------------------------------------
// One saved flag per sidebar view entry (by nav id). Cluster, Analysis and Editor
// reuse the Sections flags above, so the Settings toggles and the sidebar's
// right-click menu read and write the same values. Every entry is shown by
// default except Editor.
const NAV_ENTRY_SHOW_PREFS: Record<string, { key: string; fallback: boolean }> = {
  tasks: { key: "pi-lab.sections.showTasks", fallback: true },
  latex: { key: "pi-lab.sections.showLatex", fallback: true },
  library: { key: "pi-lab.sections.showLibrary", fallback: true },
  analysis: { key: SHOW_ANALYSIS_SECTION_KEY, fallback: true },
  cluster: { key: SHOW_CLUSTER_SECTION_KEY, fallback: true },
  skills: { key: "pi-lab.sections.showSkills", fallback: true },
  workflows: { key: "pi-lab.sections.showRoutines", fallback: true },
  editor: { key: SHOW_EDITOR_SECTION_KEY, fallback: false },
}

function navEntryShowPref(id: string): { key: string; fallback: boolean } {
  const pref = NAV_ENTRY_SHOW_PREFS[id]
  if (!pref) throw new Error(`Unknown sidebar view entry: ${id}`)
  return pref
}

function subscribeNavEntries(callback: () => void): () => void {
  const unsubscribes = Object.values(NAV_ENTRY_SHOW_PREFS).map(({ key }) =>
    subscribePref(key, callback),
  )
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe()
  }
}

/** The shown ids as one string, so the snapshot is stable between writes. */
function readShownNavEntriesKey(): string {
  return Object.entries(NAV_ENTRY_SHOW_PREFS)
    .filter(([, { key, fallback }]) => readBoolean(key, fallback))
    .map(([id]) => id)
    .join(",")
}

const DEFAULT_SHOWN_NAV_ENTRIES_KEY = Object.entries(NAV_ENTRY_SHOW_PREFS)
  .filter(([, { fallback }]) => fallback)
  .map(([id]) => id)
  .join(",")

/**
 * Which sidebar view entries are shown (a set of nav ids) and a setter for one
 * entry. Throws for an id that has no saved flag.
 */
export function useShownNavEntries(): [ReadonlySet<string>, (id: string, shown: boolean) => void] {
  const key = useSyncExternalStore(
    subscribeNavEntries,
    readShownNavEntriesKey,
    () => DEFAULT_SHOWN_NAV_ENTRIES_KEY,
  )
  const shown = useMemo(() => new Set(key === "" ? [] : key.split(",")), [key])
  const set = useCallback((id: string, next: boolean) => {
    writePref(navEntryShowPref(id).key, String(next))
  }, [])
  return [shown, set]
}

// --- Projects: one reveal state shared by Dashboard and sidebar ---------------
// This controls only whether archived projects are temporarily visible; the
// durable hidden state itself remains `projects.archivedAt` in the local DB.
const SHOW_HIDDEN_PROJECTS_KEY = "pi-lab.projects.showHidden"
export const useShowHiddenProjects = (
  hiddenCount: number | null,
): [boolean, (next: boolean) => void] => {
  const [showHidden, setShowHidden] = useBooleanPref(SHOW_HIDDEN_PROJECTS_KEY, false)
  useEffect(() => {
    if (hiddenCount === 0 && showHidden) setShowHidden(false)
  }, [hiddenCount, setShowHidden, showHidden])
  return [showHidden, setShowHidden]
}

const SHOW_EXPERIMENTS_SECTION_KEY = "pi-lab.sections.showExperiments"
export const useShowExperimentsSection = (): [boolean, (next: boolean) => void] =>
  useBooleanPref(SHOW_EXPERIMENTS_SECTION_KEY, true)

const SHOW_RESEARCH_HEARTBEAT_SECTION_KEY = "pi-lab.sections.showResearchHeartbeat"
export const useShowResearchHeartbeatSection = (): [boolean, (next: boolean) => void] =>
  useBooleanPref(SHOW_RESEARCH_HEARTBEAT_SECTION_KEY, true)

// --- Skills: shared scope visibility across the science tab + project panel --
const SHOW_PROJECT_SKILLS_KEY = "pi-lab.skills.showProjectLocal"
const SHOW_GLOBAL_SKILLS_KEY = "pi-lab.skills.showGlobal"
export const useShowProjectSkills = (): [boolean, (next: boolean) => void] =>
  useBooleanPref(SHOW_PROJECT_SKILLS_KEY, true)
export const useShowGlobalSkills = (): [boolean, (next: boolean) => void] =>
  useBooleanPref(SHOW_GLOBAL_SKILLS_KEY, true)

// --- Project view: optional Skills visualization in the right sidebar --------
const SHOW_SKILLS_PANEL_KEY = "pi-lab.projectView.showSkillsPanel"
export const useShowSkillsPanel = (): [boolean, (next: boolean) => void] =>
  useBooleanPref(SHOW_SKILLS_PANEL_KEY, false)

// --- Fetch remote experiments: extra instructions appended to the agent prompt
// Passed from the renderer into `workflows.run` (the fetch-experiments task); the
// scaffolded skill NAME/path stays fixed server-side (only this free text is
// user-editable).
const FETCH_EXPERIMENTS_INSTRUCTIONS_KEY = "pi-lab.fetchExperiments.instructions"
export const readFetchExperimentsInstructions = (): string =>
  readString(FETCH_EXPERIMENTS_INSTRUCTIONS_KEY, "")
export const useFetchExperimentsInstructions = (): [string, (next: string) => void] =>
  useStringPref(FETCH_EXPERIMENTS_INSTRUCTIONS_KEY, "")

// --- Project view: show the file tree as a left column (off by default) --------
// The global default for the left Files column. A project that toggled the column
// itself keeps its own value (`filesPanelOpen` in its workspace state) instead.
// A new key: the old `pi-lab.projectView.showFilesPanel` was a global on/off switch,
// and its saved value must not turn this default on.
const SHOW_FILES_PANEL_KEY = "pi-lab.projectView.filesPanelDefault"
export const useShowFilesPanel = (): [boolean, (next: boolean) => void] =>
  useBooleanPref(SHOW_FILES_PANEL_KEY, false)

// --- Project view: restore open file/terminal/agent tabs (on by default) ------
const RESTORE_PROJECT_TABS_KEY = "pi-lab.projectView.restoreTabs"
export const readRestoreProjectTabs = (): boolean => readBoolean(RESTORE_PROJECT_TABS_KEY, true)
export const useRestoreProjectTabs = (): [boolean, (next: boolean) => void] =>
  useBooleanPref(RESTORE_PROJECT_TABS_KEY, true)

// --- Project view: right sidebar width (px), continuously resizable from its edge
const RIGHT_SIDEBAR_WIDTH_KEY = "pi-lab.projectView.rightSidebarWidth"
export const RIGHT_SIDEBAR_MIN_WIDTH = 240
export const RIGHT_SIDEBAR_MAX_WIDTH = 560
export const RIGHT_SIDEBAR_DEFAULT_WIDTH = 320
export const useRightSidebarWidth = (): [number, (next: number) => void] =>
  useNumberPref(RIGHT_SIDEBAR_WIDTH_KEY, RIGHT_SIDEBAR_DEFAULT_WIDTH)

// --- Research diary panel (project view and Analysis): shown or hidden, and width (px)
// One shared value for both views: hiding it in one view hides it in the other too.
export const useResearchDiaryOpen = (): [boolean, (next: boolean) => void] =>
  useBooleanPref("pi-lab.researchDiary.open", true)
export const RESEARCH_DIARY_MIN_WIDTH = 240
export const RESEARCH_DIARY_MAX_WIDTH = 720
export const RESEARCH_DIARY_DEFAULT_WIDTH = 340
export const useResearchDiaryWidth = (): [number, (next: number) => void] =>
  useNumberPref("pi-lab.researchDiary.width", RESEARCH_DIARY_DEFAULT_WIDTH)

// --- Project view: left Files panel width (px), continuously resizable ---------
const FILES_PANEL_WIDTH_KEY = "pi-lab.projectView.filesPanelWidth"
export const FILES_PANEL_MIN_WIDTH = 160
export const FILES_PANEL_MAX_WIDTH = 480
export const FILES_PANEL_DEFAULT_WIDTH = 224
export const useFilesPanelWidth = (): [number, (next: number) => void] =>
  useNumberPref(FILES_PANEL_WIDTH_KEY, FILES_PANEL_DEFAULT_WIDTH)

// --- File tree: one global sort shared by every project/tree placement -------
export type FileTreeSort = "name-asc" | "name-desc" | "type" | "modified"
const FILE_TREE_SORT_KEY = "pi-lab.fileTree.sort"
const FILE_TREE_SORT_VALUES = new Set<FileTreeSort>(["name-asc", "name-desc", "type", "modified"])
export const useFileTreeSort = (): [FileTreeSort, (next: FileTreeSort) => void] => {
  const [stored, setStored] = useStringPref(FILE_TREE_SORT_KEY, "name-asc")
  const sort = FILE_TREE_SORT_VALUES.has(stored as FileTreeSort)
    ? (stored as FileTreeSort)
    : "name-asc"
  return [sort, setStored]
}

// --- Editor typography: global across every project/CodeMirror instance ------
export const EDITOR_FONT_DEFAULT_FAMILY = "default"
export const EDITOR_FONT_DEFAULT_SIZE = 14
export const EDITOR_FONT_MIN_SIZE = 10
export const EDITOR_FONT_MAX_SIZE = 24
export const EDITOR_SAFE_MONOSPACE_STACK =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

const EDITOR_FONT_FAMILY_KEY = "pi-lab.editor.fontFamily"
const EDITOR_FONT_SIZE_KEY = "pi-lab.editor.fontSize"

function boundedEditorFontSize(value: number): number {
  if (!Number.isFinite(value)) return EDITOR_FONT_DEFAULT_SIZE
  return Math.min(EDITOR_FONT_MAX_SIZE, Math.max(EDITOR_FONT_MIN_SIZE, Math.round(value)))
}

export const useEditorFontFamily = (): [string, (next: string) => void] => {
  const [stored, setStored] = useStringPref(EDITOR_FONT_FAMILY_KEY, EDITOR_FONT_DEFAULT_FAMILY)
  const family = stored.trim().length > 0 ? stored : EDITOR_FONT_DEFAULT_FAMILY
  return [family, setStored]
}

export const useEditorFontSize = (): [number, (next: number) => void] => {
  const [stored, setStored] = useNumberPref(EDITOR_FONT_SIZE_KEY, EDITOR_FONT_DEFAULT_SIZE)
  const setSize = useCallback((next: number) => setStored(boundedEditorFontSize(next)), [setStored])
  return [boundedEditorFontSize(stored), setSize]
}

export function editorFontFamilyCss(family: string): string {
  return family === EDITOR_FONT_DEFAULT_FAMILY
    ? EDITOR_SAFE_MONOSPACE_STACK
    : `${JSON.stringify(family)}, ${EDITOR_SAFE_MONOSPACE_STACK}`
}

// --- Left sidebar: collapsed to an icon-only rail (expanded by default) -------
const SIDEBAR_COLLAPSED_KEY = "pi-lab.sidebar.collapsed"
export const readSidebarCollapsed = (): boolean => readBoolean(SIDEBAR_COLLAPSED_KEY, false)
export const useSidebarCollapsed = (): [boolean, (next: boolean) => void] =>
  useBooleanPref(SIDEBAR_COLLAPSED_KEY, false)

// --- Left sidebar: expanded width (px), continuously resizable from the edge ---
// Dragging the edge below SIDEBAR_MIN_WIDTH snaps to the collapsed icon rail (so
// labels never get cramped); the width is clamped to [MIN, MAX] otherwise.
const SIDEBAR_WIDTH_KEY = "pi-lab.sidebar.width"
export const SIDEBAR_MIN_WIDTH = 180
export const SIDEBAR_MAX_WIDTH = 360
export const SIDEBAR_DEFAULT_WIDTH = 240
export const readSidebarWidth = (): number => readNumber(SIDEBAR_WIDTH_KEY, SIDEBAR_DEFAULT_WIDTH)
export const useSidebarWidth = (): [number, (next: number) => void] =>
  useNumberPref(SIDEBAR_WIDTH_KEY, SIDEBAR_DEFAULT_WIDTH)

// --- Left sidebar: app-wide hover/focus feature help (shown by default) -------
// The compact lower-left panel explains the interactive element under the
// pointer or keyboard focus. It is renderer-only and can be dismissed/restored
// directly from the sidebar.
const SIDEBAR_SHOW_FEATURE_HELP_KEY = "pi-lab.sidebar.showFeatureHelp"
export const useSidebarFeatureHelp = (): [boolean, (next: boolean) => void] =>
  useBooleanPref(SIDEBAR_SHOW_FEATURE_HELP_KEY, true)

// --- Ordered-id preferences (drag-to-reorder lists) ---------------------------
// Stored as a JSON array of ids; the consuming list renders known ids in this
// order and appends any not-yet-seen ids (so new items still show). Cached per
// key so useSyncExternalStore gets a STABLE snapshot reference — returning a
// freshly-parsed array on every read would loop forever.
// An unset key (`""`) yields the caller's `fallback` (a seed); an explicitly-
// stored `"[]"` stays empty, so a user who clears a seeded list keeps it cleared.
// `fallback` must be a STABLE reference (a module const) so useSyncExternalStore
// gets an unchanging snapshot when the key is unset.
const EMPTY_ORDER: string[] = []
const orderCache = new Map<string, { raw: string; value: string[] }>()
function readOrder(key: string, fallback: string[]): string[] {
  if (typeof window === "undefined") return fallback
  const raw = window.localStorage.getItem(key) ?? ""
  if (raw === "") return fallback
  const cached = orderCache.get(key)
  if (cached && cached.raw === raw) return cached.value
  let value: string[] = fallback
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) value = parsed.filter((x): x is string => typeof x === "string")
  } catch {
    value = fallback
  }
  orderCache.set(key, { raw, value })
  return value
}
function useOrderPref(key: string, fallback: string[]): [string[], (next: string[]) => void] {
  const subscribe = useCallback((cb: () => void) => subscribePref(key, cb), [key])
  const getSnapshot = useCallback(() => readOrder(key, fallback), [key, fallback])
  const value = useSyncExternalStore(subscribe, getSnapshot, () => fallback)
  const set = useCallback((next: string[]) => writePref(key, JSON.stringify(next)), [key])
  return [value, set]
}

/** Persisted drag order for the sidebar science/Workflows nav (by item id). */
export const useNavOrder = (): [string[], (next: string[]) => void] =>
  useOrderPref("pi-lab.sidebar.navOrder", EMPTY_ORDER)
/** Persisted drag order for the cluster machine list (by machine id). */
export const useClusterOrder = (): [string[], (next: string[]) => void] =>
  useOrderPref("pi-lab.cluster.machineOrder", EMPTY_ORDER)
/** Default project-view right-sidebar tab order; tabs not listed follow in their natural order. */
const DEFAULT_RIGHT_SIDEBAR_TAB_ORDER: string[] = ["files", "research", "todos"]
/** Persisted drag order for the project-view right-sidebar tabs (by tab id), shared by every project. */
export const useRightSidebarTabOrder = (): [string[], (next: string[]) => void] =>
  useOrderPref("pi-lab.projectView.sidebarTabOrder", DEFAULT_RIGHT_SIDEBAR_TAB_ORDER)
/** The views whose top bar has a "+" shortcut menu, each with its own saved list. */
export type HeaderShortcutsView = "project" | "latex" | "tasks" | "analysis"
/**
 * Default top bar shortcuts per view, in top bar order. Built-in ids are the
 * view's own buttons (Project view: `tasks`, `paper`, `auto-research`,
 * `plan-research`, `project-status`, `research-diary`; LaTeX Editor: `update-paper`,
 * `sync`; Analysis: `analyze-experiments`, `html-report`, `fetch-experiments`,
 * `research-diary`; Tasks has none);
 * added skills and routines are stored as `skill:<slug>` and
 * `routine:<automation id>`.
 */
export const DEFAULT_HEADER_SHORTCUTS: Record<HeaderShortcutsView, string[]> = {
  project: ["tasks", "paper", "auto-research", "plan-research", "project-status", "research-diary"],
  latex: ["update-paper", "sync"],
  tasks: [],
  analysis: ["analyze-experiments", "html-report", "fetch-experiments", "research-diary"],
}
const HEADER_SHORTCUTS_KEYS: Record<HeaderShortcutsView, string> = {
  project: "pi-lab.projectView.headerShortcuts",
  latex: "pi-lab.latexEditor.headerShortcuts",
  tasks: "pi-lab.tasks.headerShortcuts",
  analysis: "pi-lab.analysis.headerShortcuts",
}
/**
 * Built-in ids that became listable in each version of the saved lists. A list
 * saved at an older `<key>Version` (none means "1") gets the ids of every later
 * version added at their default positions; any write saves the current
 * version, so a later removal stays.
 */
const HEADER_SHORTCUTS_ADDED: { version: number; ids: Record<HeaderShortcutsView, string[]> }[] = [
  {
    version: 2,
    ids: {
      project: [],
      latex: ["sync"],
      tasks: [],
      analysis: ["html-report", "fetch-experiments"],
    },
  },
  { version: 3, ids: { project: ["paper"], latex: [], tasks: [], analysis: [] } },
  {
    version: 4,
    ids: { project: ["research-diary"], latex: [], tasks: [], analysis: ["research-diary"] },
  },
]
const HEADER_SHORTCUTS_VERSION = "4"
/** `saved` with each id of `added` that it lacks put after its nearest default predecessor. */
function withAddedShortcuts(saved: string[], defaults: string[], added: string[]): string[] {
  const next = [...saved]
  for (const id of added) {
    if (next.includes(id)) continue
    const before = defaults.slice(0, defaults.indexOf(id)).filter((entry) => next.includes(entry))
    const anchor = before.at(-1)
    next.splice(anchor === undefined ? 0 : next.indexOf(anchor) + 1, 0, id)
  }
  return next
}
/** One view's top bar shortcut buttons (by id, in order), shared by every project. */
export const useHeaderShortcuts = (
  view: HeaderShortcutsView,
): [string[], (next: string[]) => void] => {
  const key = HEADER_SHORTCUTS_KEYS[view]
  const [saved, setSaved] = useOrderPref(key, DEFAULT_HEADER_SHORTCUTS[view])
  const [version, setVersion] = useStringPref(`${key}Version`, "1")
  const value = useMemo(
    () =>
      withAddedShortcuts(
        saved,
        DEFAULT_HEADER_SHORTCUTS[view],
        HEADER_SHORTCUTS_ADDED.filter((entry) => entry.version > Number(version)).flatMap(
          (entry) => entry.ids[view],
        ),
      ),
    [saved, version, view],
  )
  const set = useCallback(
    (next: string[]) => {
      setVersion(HEADER_SHORTCUTS_VERSION)
      setSaved(next)
    },
    [setSaved, setVersion],
  )
  return [value, set]
}
/** Where experiment runs are tracked. One kind for now: an EXPERIMENTS.md-style table file. */
export type ExperimentRunsSource = "experiments-md"
/** The default experiments file, relative to each project. */
export const DEFAULT_EXPERIMENT_RUNS_FILE = "EXPERIMENTS.md"
/** The experiment-runs source for the Project status card (app-wide). */
export const useExperimentRunsSource = (): [
  ExperimentRunsSource,
  (next: ExperimentRunsSource) => void,
] => {
  const [stored, setStored] = useStringPref("pi-lab.experiments.runsSource", "experiments-md")
  // EXPERIMENTS.md is the only kind so far; a stored value from a later build reads as it.
  const value: ExperimentRunsSource = stored === "experiments-md" ? stored : "experiments-md"
  return [value, setStored]
}
/** The experiments file path, relative to each project (app-wide; default EXPERIMENTS.md). */
export const useExperimentRunsFile = (): [string, (next: string) => void] =>
  useStringPref("pi-lab.experiments.runsFile", DEFAULT_EXPERIMENT_RUNS_FILE)
/** The default Analysis results folder, relative to each project. */
export const DEFAULT_RESULTS_FOLDER = "results"
/**
 * The default Analysis results folder, relative to each project (app-wide;
 * default `results`). Each folder inside it is one experiment. A project can
 * use its own folder instead (`metadata.resultsFolder`).
 */
export const useDefaultResultsFolder = (): [string, (next: string) => void] =>
  useStringPref("pi-lab.experiments.resultsFolder", DEFAULT_RESULTS_FOLDER)

// --- Global emoji-tag palette: shared across ALL projects ---------------------
// The reusable set of emoji the "Edit project…" dialog offers as toggle chips.
// It is a single global palette (the user reuses the same tags everywhere), NOT
// per-project — a project's *assigned* tags live in its `metadata.emojiTags`.
// Seeded small; the user grows it via the dialog's "+" and prunes it by
// right-clicking a chip.
const EMOJI_TAG_PALETTE_KEY = "pi-lab.emojiTagPalette"
const DEFAULT_EMOJI_TAG_PALETTE: string[] = ["🔬", "🧪", "🚀", "💡", "💼", "🥭", "🐬", "☑️"]
export const readEmojiTagPalette = (): string[] =>
  readOrder(EMOJI_TAG_PALETTE_KEY, DEFAULT_EMOJI_TAG_PALETTE)
export const useEmojiTagPalette = (): [string[], (next: string[]) => void] =>
  useOrderPref(EMOJI_TAG_PALETTE_KEY, DEFAULT_EMOJI_TAG_PALETTE)

// --- Experimental: gate v2 surfaces (integrations / teams) --------------------
const EXPERIMENTAL_V2_KEY = "pi-lab.experimentalV2"
export const readExperimentalV2 = (): boolean => readBoolean(EXPERIMENTAL_V2_KEY, false)
export const useExperimentalV2 = (): [boolean, (next: boolean) => void] =>
  useBooleanPref(EXPERIMENTAL_V2_KEY, false)

// --- Default agent for new sessions ------------------------------------------
const DEFAULT_AGENT_KEY = "pi-lab.defaultAgentId"

/** The user's preferred default agent id (falls back to the built-in default). */
export function readDefaultAgentId(): string {
  if (typeof window === "undefined") return DEFAULT_AGENT_ID
  const raw = window.localStorage.getItem(DEFAULT_AGENT_KEY)?.trim()
  return raw && raw.length > 0 ? raw : DEFAULT_AGENT_ID
}

/** Migrate the legacy renderer preference, then share the persisted app default. */
export function useDefaultAgentId(): [
  string,
  (next: string) => Promise<boolean>,
  string | null,
  boolean,
] {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const query = useQuery(trpc.settings.get.queryOptions())
  const [legacy, setLegacy] = useStringPref(DEFAULT_AGENT_KEY, DEFAULT_AGENT_ID)
  const accept = (agents: NonNullable<typeof query.data>["agents"]) => {
    queryClient.setQueryData(trpc.settings.get.queryKey(), (current) =>
      current ? { ...current, agents } : current,
    )
  }
  const update = useMutation(trpc.settings.updateAgents.mutationOptions({ onSuccess: accept }))
  const initialize = useMutation(
    trpc.settings.initializeDefaultAgent.mutationOptions({ onSuccess: accept }),
  )
  const saved = query.data?.agents?.defaultAgentId
  useEffect(() => {
    if (saved) setLegacy(saved)
  }, [saved, setLegacy])
  useEffect(() => {
    if (saved !== null || initialize.isPending || initialize.isError) return
    initialize.mutate({ agentId: legacy.trim() || DEFAULT_AGENT_ID })
  }, [saved, legacy, initialize.isPending, initialize.isError, initialize.mutate])
  const set = (next: string) =>
    update.mutateAsync({ defaultAgentId: next.trim() || DEFAULT_AGENT_ID }).then(
      () => true,
      () => false,
    )
  return [
    saved ?? (legacy.trim() || DEFAULT_AGENT_ID),
    set,
    update.error?.message ??
      (saved === null ? initialize.error?.message : undefined) ??
      query.error?.message ??
      null,
    query.isPending ||
      initialize.isPending ||
      update.isPending ||
      (saved === null && !initialize.isError),
  ]
}

/**
 * The agent id to launch a session with: the deterministic `?agentId` E2E seam
 * wins, otherwise the user's stored default. Keeps the
 * test seam working while honouring the Settings → Agents default.
 */
export function resolveLaunchAgentId(defaultAgentId?: string): string {
  if (typeof window !== "undefined") {
    const override = new URLSearchParams(window.location.search).get("agentId")?.trim()
    if (override && override.length > 0) return override
  }
  return defaultAgentId ?? readDefaultAgentId()
}

// --- New-session shortcut (⌘T): what it opens in the central panel ----------
/** What the new-session shortcut opens. "chat-agent" is reserved until chat sessions exist. */
export type NewSessionKind = "chat-agent" | "terminal-agent" | "terminal"
const NEW_SESSION_KIND_KEY = "pi-lab.shortcuts.newSessionKind"
/** Kinds the shortcut can open today; chat agents are not built yet. */
const NEW_SESSION_KINDS = new Set<NewSessionKind>(["terminal-agent", "terminal"])
const DEFAULT_NEW_SESSION_KIND: NewSessionKind = "terminal-agent"

/** Parse a stored value; anything unknown or not yet available falls back to the default. */
function toNewSessionKind(raw: string): NewSessionKind {
  return NEW_SESSION_KINDS.has(raw as NewSessionKind)
    ? (raw as NewSessionKind)
    : DEFAULT_NEW_SESSION_KIND
}

/** Read at key time by the shortcut handler, so a change in Settings applies at once. */
export const readNewSessionKind = (): NewSessionKind =>
  toNewSessionKind(readString(NEW_SESSION_KIND_KEY, DEFAULT_NEW_SESSION_KIND))
export const useNewSessionKind = (): [NewSessionKind, (next: NewSessionKind) => void] => {
  const [stored, setStored] = useStringPref(NEW_SESSION_KIND_KEY, DEFAULT_NEW_SESSION_KIND)
  return [toNewSessionKind(stored), setStored]
}
