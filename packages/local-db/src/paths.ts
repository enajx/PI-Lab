import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Root directory for all of PI Lab's on-disk state.
 *
 * Overridable via `PI_LAB_DATA_DIR` so tests and parallel
 * instances can point at a throwaway directory; defaults to `~/.pi-lab`.
 */
export function resolveDataDir(): string {
  const override = process.env.PI_LAB_DATA_DIR?.trim()
  return override && override.length > 0 ? override : join(homedir(), ".pi-lab")
}

/** Absolute path of the SQLite database file inside the data directory. */
export function resolveDbPath(): string {
  return join(resolveDataDir(), "local.db")
}

/**
 * Directory the generated Drizzle migrations live in. Resolved relative to this
 * source file so it works from `src/` in dev/test and from compiled output that
 * ships `drizzle/` alongside it.
 */
export function resolveMigrationsDir(): string {
  return join(import.meta.dirname, "..", "drizzle")
}
