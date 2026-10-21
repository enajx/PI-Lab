import type { InterfaceLanguage } from "./language"

type Locale = Exclude<InterfaceLanguage, "en">
type Messages = Record<string, string>

const loaders: Record<Locale, () => Promise<Messages>> = {
  "zh-CN": () => import("./locales/zh-CN.json").then((module) => module.default),
  ko: () => import("./locales/ko.json").then((module) => module.default),
  ja: () => import("./locales/ja.json").then((module) => module.default),
  es: () => import("./locales/es.json").then((module) => module.default),
  ar: () => import("./locales/ar.json").then((module) => module.default),
  nb: () => import("./locales/nb.json").then((module) => module.default),
}
const tables = new Map<Locale, Messages>()
const pending = new Map<Locale, Promise<void>>()

export function hasMessages(language: InterfaceLanguage): boolean {
  return language === "en" || tables.has(language)
}

/** English needs no table; each other locale is loaded once, with failures retryable. */
export function loadMessages(language: InterfaceLanguage): Promise<void> {
  if (language === "en" || tables.has(language)) return Promise.resolve()
  const existing = pending.get(language)
  if (existing) return existing
  const loaded = loaders[language]().then(
    (messages) => {
      tables.set(language, messages)
      pending.delete(language)
    },
    (error: unknown) => {
      pending.delete(language)
      throw error
    },
  )
  pending.set(language, loaded)
  return loaded
}

/** Interface copy is keyed by English wording; unknown copy stays readable. */
export function translate(language: InterfaceLanguage, english: string): string {
  return language === "en" ? english : (tables.get(language)?.[english] ?? english)
}
