export const INTERFACE_LANGUAGE_CHANNEL = "pi-lab:interface-language"

const languageCodes = ["en", "zh-CN", "ko", "ja", "es", "ar", "nb"] as const

/** Keep the preload IPC surface limited to supported interface languages. */
export function isInterfaceLanguage(value: unknown): value is (typeof languageCodes)[number] {
  return languageCodes.includes(value as (typeof languageCodes)[number])
}
