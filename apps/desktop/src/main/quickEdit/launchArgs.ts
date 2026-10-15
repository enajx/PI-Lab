import { existsSync, statSync } from "node:fs"
import { resolve } from "node:path"

/** Find a user file across packaged and Electron development argv layouts. */
export function firstFileArgument(
  argv: string[],
  cwd: string,
  mainEntryPath: string,
): string | null {
  const entry = resolve(mainEntryPath)
  for (const arg of argv.slice(1)) {
    if (arg.startsWith("-")) continue
    const path = resolve(cwd, arg)
    if (path === entry) continue
    if (existsSync(path) && statSync(path).isFile()) return path
  }
  return null
}
