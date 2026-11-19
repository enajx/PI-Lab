import { existsSync, globSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

/** ssh stops following Include lines this deep. */
const MAX_INCLUDE_DEPTH = 16

/** The words of a config value; double quotes group words with spaces. */
function words(value: string): string[] {
  return [...value.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? "")
}

/**
 * The Host names of the user's ssh config, in file order and without
 * duplicates, for the Add machine form. Patterns (`*`, `?`) and negations
 * (`!host`) are left out; `Match` blocks are ignored. `Include` lines are
 * followed like ssh does: `~` is the home folder, a relative path starts at
 * the folder of `configPath` (`~/.ssh`), globs are expanded. A missing file
 * gives no hosts.
 */
export function readSshConfigHosts(configPath: string): string[] {
  const hosts = new Set<string>()
  const seen = new Set<string>()
  const read = (path: string, depth: number): void => {
    const file = resolve(path)
    if (depth > MAX_INCLUDE_DEPTH || seen.has(file)) return
    if (!existsSync(file) || !statSync(file).isFile()) return
    seen.add(file)
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim()
      if (line === "" || line.startsWith("#")) continue
      const match = line.match(/^(\S+?)(?:\s*=\s*|\s+)(.*)$/)
      if (!match) continue
      const keyword = (match[1] ?? "").toLowerCase()
      const values = words(match[2] ?? "")
      if (keyword === "host") {
        for (const name of values) {
          if (!/[*?]/.test(name) && !name.startsWith("!")) hosts.add(name)
        }
      }
      if (keyword === "include") {
        for (const value of values) {
          const expanded = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value
          const pattern = isAbsolute(expanded) ? expanded : join(dirname(configPath), expanded)
          for (const found of globSync(pattern).sort()) read(found, depth + 1)
        }
      }
    }
  }
  read(configPath, 0)
  return [...hosts]
}
