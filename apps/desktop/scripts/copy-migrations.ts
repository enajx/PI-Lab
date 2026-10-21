import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

/** Replace the build's migration directory with only journaled SQL and its journal. */
export function copyRuntimeMigrations(from: string, to: string): void {
  const journal = JSON.parse(readFileSync(join(from, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>
  }
  rmSync(to, { recursive: true, force: true })
  mkdirSync(join(to, "meta"), { recursive: true })
  copyFileSync(join(from, "meta", "_journal.json"), join(to, "meta", "_journal.json"))
  for (const { tag } of journal.entries) {
    copyFileSync(join(from, `${tag}.sql`), join(to, `${tag}.sql`))
  }
}
