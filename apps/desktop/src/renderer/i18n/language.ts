import { useCallback, useSyncExternalStore } from "react"
import { hasMessages, loadMessages, translate } from "./messages"

export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "zh-CN", label: "简体中文" },
  { code: "ko", label: "한국어" },
  { code: "ja", label: "日本語" },
  { code: "es", label: "Español" },
  { code: "ar", label: "العربية" },
  { code: "nb", label: "Norsk bokmål" },
] as const

export type InterfaceLanguage = (typeof LANGUAGES)[number]["code"]
const KEY = "pi-lab.interface.language"
const listeners = new Set<() => void>()
let request = 0

/** Read the selected interface language, falling back to English for old or invalid values. */
export function readInterfaceLanguage(): InterfaceLanguage {
  if (typeof window === "undefined") return "en"
  const stored = window.localStorage.getItem(KEY)
  return LANGUAGES.find((item) => item.code === stored)?.code ?? "en"
}

function applyLanguage(language: InterfaceLanguage): void {
  window.localStorage.setItem(KEY, language)
  window.piLab?.setInterfaceLanguage?.(language)
  document.documentElement.lang = language
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr"
  for (const notify of listeners) notify()
}

/** Publish only a ready locale, and ignore responses for superseded choices. */
export function setInterfaceLanguage(language: InterfaceLanguage): Promise<void> | undefined {
  const generation = ++request
  if (hasMessages(language)) {
    applyLanguage(language)
    return
  }
  return loadMessages(language).then(
    () => {
      if (generation === request) applyLanguage(language)
    },
    (error: unknown) => {
      if (generation !== request) return
      console.error("Could not load interface language", language, error)
      applyLanguage("en")
    },
  )
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify)
  return () => listeners.delete(notify)
}

/** Reactive renderer language preference. */
export function useInterfaceLanguage(): [InterfaceLanguage, (next: InterfaceLanguage) => void] {
  const language = useSyncExternalStore(
    subscribe,
    readInterfaceLanguage,
    (): InterfaceLanguage => "en",
  )
  const setLanguage = useCallback((next: InterfaceLanguage) => setInterfaceLanguage(next), [])
  return [language, setLanguage]
}

/** Return a translation function that updates when the language changes. */
export function useTranslate(): (english: string) => string {
  const [language] = useInterfaceLanguage()
  return useCallback((english: string) => translate(language, english), [language])
}

/** Set the document language and direction before React paints the first view. */
export function initializeInterfaceLanguage(): Promise<void> {
  return Promise.resolve(setInterfaceLanguage(readInterfaceLanguage()))
}
