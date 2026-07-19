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

// --- Project view: show the "Code changes" panel (hidden by default) ----------
const SHOW_CODE_CHANGES_KEY = "pi-lab.projectView.showCodeChanges"
export const readShowCodeChanges = (): boolean => readBoolean(SHOW_CODE_CHANGES_KEY, false)
export const useShowCodeChanges = (): [boolean, (next: boolean) => void] =>
  useBooleanPref(SHOW_CODE_CHANGES_KEY, false)

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
const EMPTY_ORDER: string[] = []
const orderCache = new Map<string, { raw: string; value: string[] }>()
function readOrder(key: string): string[] {
  if (typeof window === "undefined") return EMPTY_ORDER
  const raw = window.localStorage.getItem(key) ?? ""
  const cached = orderCache.get(key)
  if (cached && cached.raw === raw) return cached.value
  let value: string[] = EMPTY_ORDER
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) value = parsed.filter((x): x is string => typeof x === "string")
    } catch {
      value = EMPTY_ORDER
    }
  }
  orderCache.set(key, { raw, value })
  return value
}
function useOrderPref(key: string): [string[], (next: string[]) => void] {
  const subscribe = useCallback((cb: () => void) => subscribePref(key, cb), [key])
  const getSnapshot = useCallback(() => readOrder(key), [key])
  const value = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_ORDER)
  const set = useCallback((next: string[]) => writePref(key, JSON.stringify(next)), [key])
  return [value, set]
}

/** Persisted drag order for the sidebar science/Workflows nav (by item id). */
export const useNavOrder = (): [string[], (next: string[]) => void] =>
  useOrderPref("pi-lab.sidebar.navOrder")
/** Persisted drag order for the sidebar project list (by project id). */
export const useProjectOrder = (): [string[], (next: string[]) => void] =>
  useOrderPref("pi-lab.sidebar.projectOrder")
/** Persisted drag order for the cluster machine list (by machine id). */
export const useClusterOrder = (): [string[], (next: string[]) => void] =>
  useOrderPref("pi-lab.cluster.machineOrder")

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
