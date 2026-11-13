import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"
import {
  APP_THEME_TOKENS,
  APP_THEMES,
  DEFAULT_ACCENT_ID,
  DEFAULT_APP_THEME_ID,
  normalizeAccentId,
  normalizeAppThemeId,
  type ResolvedThemeMode,
  resolveAppThemeTokens,
} from "./appThemes"

export type ThemeMode = "dark" | "light" | "system"

interface ThemeContextValue {
  mode: ThemeMode
  resolvedMode: ResolvedThemeMode
  setMode: (mode: ThemeMode) => void
  /** Show a mode without saving it; null ends the preview. Saving a mode also ends it. */
  previewMode: (mode: ThemeMode | null) => void
  /** The theme in use: a preview, else the saved one. */
  themeId: string
  setThemeId: (themeId: string) => void
  /**
   * The accent in use: a preview, else the one saved for the theme in use
   * ("default", a preset id, or `#rrggbb`).
   */
  accentId: string
  /** Save the accent of the saved theme; each theme keeps its own. */
  setAccentId: (accentId: string) => void
  /** Show a theme without saving it; null ends the preview. Saving a theme also ends it. */
  previewThemeId: (themeId: string | null) => void
  /** Show an accent without saving it; null ends the preview. Saving an accent also ends it. */
  previewAccentId: (accentId: string | null) => void
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

const MODE_STORAGE_KEY = "pi-lab.theme"
const APP_THEME_STORAGE_KEY = "pi-lab.appTheme"
/** Before accents were per theme, one accent applied to every theme. */
const GLOBAL_ACCENT_STORAGE_KEY = "pi-lab.appAccent"
const accentStorageKey = (themeId: string) => `pi-lab.appAccent.${themeId}`
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)"

function readInitialMode(): ThemeMode {
  if (typeof window === "undefined") return "light"
  const stored = window.localStorage.getItem(MODE_STORAGE_KEY)
  return stored === "dark" || stored === "system" ? stored : "light"
}

function readInitialThemeId(): string {
  if (typeof window === "undefined") return DEFAULT_APP_THEME_ID
  return normalizeAppThemeId(window.localStorage.getItem(APP_THEME_STORAGE_KEY))
}

/**
 * Each theme's saved accent. An accent saved by an earlier build for every theme
 * moves to the saved theme (unless it already has one) and the old key is removed.
 */
function readInitialAccents(): Record<string, string> {
  if (typeof window === "undefined") return {}
  const storage = window.localStorage
  const global = storage.getItem(GLOBAL_ACCENT_STORAGE_KEY)
  if (global !== null) {
    const active = accentStorageKey(readInitialThemeId())
    if (storage.getItem(active) === null) storage.setItem(active, normalizeAccentId(global))
    storage.removeItem(GLOBAL_ACCENT_STORAGE_KEY)
  }
  return Object.fromEntries(
    APP_THEMES.map(({ id }) => [id, normalizeAccentId(storage.getItem(accentStorageKey(id)))]),
  )
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.(SYSTEM_DARK_QUERY).matches === true
}

function applyTheme(themeId: string, mode: ResolvedThemeMode, accentId: string) {
  if (typeof document === "undefined") return
  const root = document.documentElement
  root.classList.toggle("dark", mode === "dark")
  root.style.colorScheme = mode

  const tokens = resolveAppThemeTokens(themeId, mode, accentId)
  for (const token of APP_THEME_TOKENS) {
    const property = `--${token}`
    const value = tokens?.[token]
    if (value) root.style.setProperty(property, value)
    else root.style.removeProperty(property)
  }
}

/** Set the saved appearance before the quick editor's first React render. */
export function applySavedAppearance(): void {
  const selected = readInitialMode()
  const resolved = selected === "system" ? (systemPrefersDark() ? "dark" : "light") : selected
  const themeId = readInitialThemeId()
  applyTheme(themeId, resolved, readInitialAccents()[themeId] ?? DEFAULT_ACCENT_ID)
}

/**
 * Owns the app-appearance choices: a light/dark/system mode, a named UI palette,
 * and an accent per palette. The resolved mode remains reflected as `.dark` for Tailwind and
 * other consumers, while palette and accent colors override the shared CSS
 * tokens. CodeMirror keeps its own editor-theme preference.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [savedMode, setSavedMode] = useState<ThemeMode>(readInitialMode)
  const [modePreview, setModePreview] = useState<ThemeMode | null>(null)
  const mode = modePreview ?? savedMode
  const [savedThemeId, setThemeIdState] = useState<string>(readInitialThemeId)
  const [accents, setAccents] = useState<Record<string, string>>(readInitialAccents)
  const [themePreview, setThemePreview] = useState<string | null>(null)
  const [accentPreview, setAccentPreview] = useState<string | null>(null)
  const [systemDark, setSystemDark] = useState(systemPrefersDark)
  const resolvedMode: ResolvedThemeMode = mode === "system" ? (systemDark ? "dark" : "light") : mode
  const themeId = themePreview ?? savedThemeId
  const accentId = accentPreview ?? accents[themeId] ?? DEFAULT_ACCENT_ID

  useEffect(() => {
    const query = window.matchMedia?.(SYSTEM_DARK_QUERY)
    if (!query) return
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    setSystemDark(query.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])

  useEffect(() => {
    applyTheme(themeId, resolvedMode, accentId)
    window.localStorage.setItem(MODE_STORAGE_KEY, savedMode)
    window.localStorage.setItem(APP_THEME_STORAGE_KEY, savedThemeId)
  }, [savedMode, resolvedMode, themeId, savedThemeId, accentId])

  const setThemeId = useCallback((nextThemeId: string) => {
    setThemePreview(null)
    setThemeIdState(normalizeAppThemeId(nextThemeId))
  }, [])
  const setAccentId = useCallback(
    (nextAccentId: string) => {
      const accent = normalizeAccentId(nextAccentId)
      setAccentPreview(null)
      setAccents((current) => ({ ...current, [savedThemeId]: accent }))
      window.localStorage.setItem(accentStorageKey(savedThemeId), accent)
    },
    [savedThemeId],
  )
  const previewThemeId = useCallback(
    (next: string | null) => setThemePreview(next === null ? null : normalizeAppThemeId(next)),
    [],
  )
  const previewAccentId = useCallback(
    (next: string | null) => setAccentPreview(next === null ? null : normalizeAccentId(next)),
    [],
  )
  const setMode = useCallback((nextMode: ThemeMode) => {
    setModePreview(null)
    setSavedMode(nextMode)
  }, [])
  const toggleTheme = useCallback(
    () => setMode(resolvedMode === "dark" ? "light" : "dark"),
    [resolvedMode, setMode],
  )

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      resolvedMode,
      setMode,
      previewMode: setModePreview,
      themeId,
      setThemeId,
      accentId,
      setAccentId,
      previewThemeId,
      previewAccentId,
      toggleTheme,
    }),
    [
      mode,
      resolvedMode,
      setMode,
      themeId,
      setThemeId,
      accentId,
      setAccentId,
      previewThemeId,
      previewAccentId,
      toggleTheme,
    ],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) throw new Error("useTheme must be used within a ThemeProvider")
  return context
}
