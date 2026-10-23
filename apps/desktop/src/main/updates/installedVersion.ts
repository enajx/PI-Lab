import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"

/** Record a successful launch; report version changes only after a previous launch. */
export function recordInstalledVersion(path: string, version: string): boolean {
  const previous = existsSync(path) ? readFileSync(path, "utf8").trim() : null
  writeFileSync(`${path}.tmp`, version, "utf8")
  renameSync(`${path}.tmp`, path)
  return previous !== null && previous !== version
}
