import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** Validate canonical flat tables before JSON parsing can silently discard duplicate keys. */
export function validateLocaleSource(source: string, path: string): void {
  const parsed: unknown = JSON.parse(source)
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((value) => typeof value !== "string")
  )
    throw new Error(`${path}: locale must be a flat string table`)
  const strings = Array.from(
    source.matchAll(/"(?:[^"\\]|\\.)*"/g),
    (match) => JSON.parse(match[0]) as string,
  )
  const values = new Map<string, string>()
  for (let index = 0; index < strings.length; index += 2) {
    const key = strings[index]
    const value = strings[index + 1]
    if (key === undefined || value === undefined)
      throw new Error(`${path}: incomplete locale entry`)
    if (values.has(key))
      throw new Error(
        `${path}: duplicate ${JSON.stringify(key)}: ${JSON.stringify(values.get(key))} / ${JSON.stringify(value)}`,
      )
    values.set(key, value)
  }
}

export function validateLocaleFiles(directory: string): void {
  for (const name of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
    const path = join(directory, name)
    validateLocaleSource(readFileSync(path, "utf8"), path)
  }
}
