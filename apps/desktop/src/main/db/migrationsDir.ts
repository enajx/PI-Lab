import { existsSync } from "node:fs"
import { join } from "node:path"

/**
 * Locate the generated Drizzle migrations folder.
 *
 * `@skipper/local-db` derives this from its own source location, but that
 * package is BUNDLED into the main process (electron.vite.config.ts), so its
 * `import.meta`/`__dirname` resolves to the bundle output — not the real
 * `packages/local-db/drizzle`. We therefore resolve it ourselves against a list
 * of candidates that covers each run mode:
 *
 *   - packaged / `--dir` build: `drizzle/` is copied next to `out/main` by the
 *     post-build copy step → `<__dirname>/drizzle`.
 *   - dev (`electron-vite dev`) and source runs: walk up to the monorepo
 *     package at `packages/local-db/drizzle`.
 *
 * The first candidate that actually contains `meta/_journal.json` wins.
 */
export function resolveBundledMigrationsDir(): string {
  const candidates = [
    join(__dirname, "drizzle"),
    join(__dirname, "..", "..", "..", "..", "packages", "local-db", "drizzle"),
    join(process.cwd(), "..", "..", "packages", "local-db", "drizzle"),
    join(process.cwd(), "packages", "local-db", "drizzle"),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, "meta", "_journal.json"))) {
      return dir
    }
  }
  // Fall back to the first candidate; the migrator will throw a clear error that
  // names the missing path if none exist.
  return candidates[0] ?? join(__dirname, "drizzle")
}
