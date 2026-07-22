import { DEFAULT_AGENT_ID } from "@pi-lab/shared"
import { useCallback, useEffect, useState, useSyncExternalStore } from "react"

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

// --- Project view: show the "Code changes" panel (hidden by default) ----------
const SHOW_CODE_CHANGES_KEY = "pi-lab.projectView.showCodeChanges"
export const readShowCodeChanges = (): boolean => readBoolean(SHOW_CODE_CHANGES_KEY, false)
export const useShowCodeChanges = (): [boolean, (next: boolean) => void] =>
  useBooleanPref(SHOW_CODE_CHANGES_KEY, false)

// --- Optional app sections: show/hide from Settings (all shown by default) ----
// Cluster and Analysis are live surfaces: their pref gates the sidebar nav row
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

// --- Project view: show the file tree as a left panel (off by default) --------
// When on, the file tree moves out of the right sidebar into a column on the
// left of the central panel; the right sidebar drops its "Files" tab.
const SHOW_FILES_PANEL_KEY = "pi-lab.projectView.showFilesPanel"
export const readShowFilesPanel = (): boolean => readBoolean(SHOW_FILES_PANEL_KEY, false)
export const useShowFilesPanel = (): [boolean, (next: boolean) => void] =>
  useBooleanPref(SHOW_FILES_PANEL_KEY, false)

// --- Project view: right sidebar width (px), continuously resizable from its edge
const RIGHT_SIDEBAR_WIDTH_KEY = "pi-lab.projectView.rightSidebarWidth"
export const RIGHT_SIDEBAR_MIN_WIDTH = 240
export const RIGHT_SIDEBAR_MAX_WIDTH = 560
export const RIGHT_SIDEBAR_DEFAULT_WIDTH = 320
export const useRightSidebarWidth = (): [number, (next: number) => void] =>
  useNumberPref(RIGHT_SIDEBAR_WIDTH_KEY, RIGHT_SIDEBAR_DEFAULT_WIDTH)

// --- Project view: left Files panel width (px), continuously resizable ---------
const FILES_PANEL_WIDTH_KEY = "pi-lab.projectView.filesPanelWidth"
export const FILES_PANEL_MIN_WIDTH = 160
export const FILES_PANEL_MAX_WIDTH = 480
export const FILES_PANEL_DEFAULT_WIDTH = 224
export const useFilesPanelWidth = (): [number, (next: number) => void] =>
  useNumberPref(FILES_PANEL_WIDTH_KEY, FILES_PANEL_DEFAULT_WIDTH)

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
/** Persisted drag order for the sidebar project list (by project id). */
export const useProjectOrder = (): [string[], (next: string[]) => void] =>
  useOrderPref("pi-lab.sidebar.projectOrder", EMPTY_ORDER)
/** Persisted drag order for the cluster machine list (by machine id). */
export const useClusterOrder = (): [string[], (next: string[]) => void] =>
  useOrderPref("pi-lab.cluster.machineOrder", EMPTY_ORDER)

// --- Global emoji-tag palette: shared across ALL projects ---------------------
// The reusable set of emoji the "Edit project…" dialog offers as toggle chips.
// It is a single global palette (the user reuses the same tags everywhere), NOT
// per-project — a project's *assigned* tags live in its `metadata.emojiTags`.
// Seeded small; the user grows it via the dialog's "+" and prunes it by
// right-clicking a chip.
const EMOJI_TAG_PALETTE_KEY = "pi-lab.emojiTagPalette"
const DEFAULT_EMOJI_TAG_PALETTE: string[] = ["🔬", "🧪", "🚀", "💡"]
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

export function useDefaultAgentId(): [string, (next: string) => void] {
  const [value, setValue] = useState<string>(() => readDefaultAgentId())
  useEffect(() => {
    persist(DEFAULT_AGENT_KEY, value)
  }, [value])
  const set = useCallback((next: string) => setValue(next), [])
  return [value, set]
}

/**
 * The agent id to launch a session with: the deterministic `?agentId` E2E seam
 * (md/engineering/testing-and-build.md) wins, otherwise the user's stored default. Keeps the
 * test seam working while honouring the Settings → Agents default.
 */
export function resolveLaunchAgentId(): string {
  if (typeof window !== "undefined") {
    const override = new URLSearchParams(window.location.search).get("agentId")?.trim()
    if (override && override.length > 0) return override
  }
  return readDefaultAgentId()
}
