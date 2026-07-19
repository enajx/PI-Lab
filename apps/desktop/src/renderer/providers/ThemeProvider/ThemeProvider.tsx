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
  themeId: string
  setThemeId: (themeId: string) => void
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

/**
 * Owns the two independent app-appearance choices: a light/dark/system mode and
 * a named UI palette. The resolved mode remains reflected as `.dark` for
 * Tailwind and other consumers, while palette colors override the shared CSS
 * tokens. CodeMirror keeps its own editor-theme preference.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(readInitialMode)
  const [themeId, setThemeIdState] = useState<string>(readInitialThemeId)
  const [systemDark, setSystemDark] = useState(systemPrefersDark)
  const resolvedMode: ResolvedThemeMode = mode === "system" ? (systemDark ? "dark" : "light") : mode

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
    window.localStorage.setItem(APP_THEME_STORAGE_KEY, themeId)
  }, [mode, resolvedMode, themeId])

  const setThemeId = useCallback(
    (nextThemeId: string) => setThemeIdState(normalizeAppThemeId(nextThemeId)),
    [],
  )
  const toggleTheme = useCallback(
    () => setMode(resolvedMode === "dark" ? "light" : "dark"),
    [resolvedMode],
  )

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolvedMode, setMode, themeId, setThemeId, toggleTheme }),
    [mode, resolvedMode, themeId, setThemeId, toggleTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) throw new Error("useTheme must be used within a ThemeProvider")
  return context
}
