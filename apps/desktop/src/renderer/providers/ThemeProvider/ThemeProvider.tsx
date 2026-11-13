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
  type AppChannel,
  type AppTheme,
  appThemesForChannel,
  availableAppThemeId,
  DEFAULT_APP_THEME_ID,
  normalizeAppThemeId,
  type ResolvedThemeMode,
  resolveAppThemeTokens,
} from "./appThemes"

export type ThemeMode = "dark" | "light" | "system"

interface ThemeContextValue {
  mode: ThemeMode
  resolvedMode: ResolvedThemeMode
  setMode: (mode: ThemeMode) => void
  /** The theme in use: the saved one, or Default when this channel does not offer it. */
  themeId: string
  setThemeId: (themeId: string) => void
  /** The themes this release channel offers in Settings. */
  themes: readonly AppTheme[]
  /** Label of a saved theme this channel does not offer (Default is used instead). */
  unavailableTheme: string | null
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

const MODE_STORAGE_KEY = "pi-lab.theme"
const APP_THEME_STORAGE_KEY = "pi-lab.appTheme"
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

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.(SYSTEM_DARK_QUERY).matches === true
}

function applyTheme(themeId: string, mode: ResolvedThemeMode) {
  if (typeof document === "undefined") return
  const root = document.documentElement
  root.classList.toggle("dark", mode === "dark")
  root.style.colorScheme = mode

  const tokens = resolveAppThemeTokens(themeId, mode)
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
  applyTheme(readInitialThemeId(), resolved)
}

/**
 * Owns the two independent app-appearance choices: a light/dark/system mode and
 * a named UI palette. The resolved mode remains reflected as `.dark` for
 * Tailwind and other consumers, while palette colors override the shared CSS
 * tokens. CodeMirror keeps its own editor-theme preference.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(readInitialMode)
  const [savedThemeId, setThemeIdState] = useState<string>(readInitialThemeId)
  const [systemDark, setSystemDark] = useState(systemPrefersDark)
  // Unknown until Electron main answers; until then the saved theme is shown as is.
  const [channel, setChannel] = useState<AppChannel | null>(null)
  const resolvedMode: ResolvedThemeMode = mode === "system" ? (systemDark ? "dark" : "light") : mode
  const themes = channel === null ? APP_THEMES : appThemesForChannel(channel)
  const themeId = channel === null ? savedThemeId : availableAppThemeId(savedThemeId, channel)
  const unavailableTheme =
    themeId === savedThemeId
      ? null
      : (APP_THEMES.find(({ id }) => id === savedThemeId)?.label ?? null)

  useEffect(() => {
    let active = true
    // Without the desktop bridge (unit tests, a plain browser) the renderer is a source run: Alpha.
    const bridge = window.piLab?.appIcon
    void (bridge ? bridge.getChannel() : Promise.resolve<AppChannel>("alpha")).then((value) => {
      if (active) setChannel(value)
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const query = window.matchMedia?.(SYSTEM_DARK_QUERY)
    if (!query) return
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    setSystemDark(query.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])

  useEffect(() => {
    applyTheme(themeId, resolvedMode)
    window.localStorage.setItem(MODE_STORAGE_KEY, mode)
    // Keep a saved theme this channel does not offer, so Settings can say why Default is shown.
    window.localStorage.setItem(APP_THEME_STORAGE_KEY, savedThemeId)
  }, [mode, resolvedMode, themeId, savedThemeId])

  const setThemeId = useCallback(
    (nextThemeId: string) => setThemeIdState(normalizeAppThemeId(nextThemeId)),
    [],
  )
  const toggleTheme = useCallback(
    () => setMode(resolvedMode === "dark" ? "light" : "dark"),
    [resolvedMode],
  )

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      resolvedMode,
      setMode,
      themeId,
      setThemeId,
      themes,
      unavailableTheme,
      toggleTheme,
    }),
    [mode, resolvedMode, themeId, setThemeId, themes, unavailableTheme, toggleTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) throw new Error("useTheme must be used within a ThemeProvider")
  return context
}
