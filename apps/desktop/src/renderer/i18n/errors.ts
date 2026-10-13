import type { InterfaceLanguage } from "./language"
import { translate } from "./messages"

const existingPath = /^A file or folder already exists at (.+)$/
const dynamicErrors: Array<readonly [RegExp, string, string]> = [
  [/^Markdown file not found: (.+)$/, "Markdown file not found: {path}", "{path}"],
  [/^No project (.+)$/, "No project {id}", "{id}"],
  [/^No agent (.+)$/, "No agent {id}", "{id}"],
  [/^The agent has not written (.+) yet$/, "The agent has not written {file} yet", "{file}"],
]

/** Translate known PI Lab validation errors while preserving path details and external diagnostics. */
export function translateKnownError(language: InterfaceLanguage, message: string): string {
  const match = existingPath.exec(message)
  if (match)
    return translate(language, "A file or folder already exists at {path}").replace(
      "{path}",
      match[1] ?? "",
    )
  for (const [pattern, template, placeholder] of dynamicErrors) {
    const parts = pattern.exec(message)
    if (parts) return translate(language, template).replace(placeholder, parts[1] ?? "")
  }
  return translate(language, message)
}
