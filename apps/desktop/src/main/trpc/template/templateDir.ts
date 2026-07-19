import { existsSync } from "node:fs"
import { cp } from "node:fs/promises"
import { basename, join } from "node:path"
import { resolveDataDir } from "@pi-lab/local-db"

/**
 * The bundled project template + its first-run seed into a writable copy.
 *
 * PI Lab ships a starter repo layout (`AGENTS.md`, the `CLAUDE.md` symlink,
 * `RESEARCH.md`, `TODO.md`, cluster/experiment notes, `.gitignore`) under
 * `apps/desktop/resources/template`. New projects are stamped from it
 * (`projects.createFromTemplate`) and the user edits it from Settings.
 *
 * Two locations matter:
 *   - the **bundled** template, read-only and resolved differently in dev vs a
 *     packaged app (mirrors {@link resolveBundledMigrationsDir});
 *   - a **writable** copy under the data dir, seeded once on first run so the
 *     user's edits survive app updates and never clobber the read-only original.
 */

/**
 * Locate the read-only bundled template directory across run modes, returning the
 * first candidate that exists on disk:
 *
 *   - packaged app: copied into the app's resources via electron-builder's
 *     `extraResources` → `<process.resourcesPath>/template`.
 *   - packaged `--dir` / source runs from compiled output: `out/main` sits two
 *     levels under `apps/desktop`, so `<__dirname>/../../resources/template`.
 *   - dev / tests: resolved from the working directory, whether that is the repo
 *     root or `apps/desktop`.
 *
 * `process.resourcesPath` is undefined outside a packaged app, so it is guarded.
 * Falls back to the first candidate if none exist; the copy then throws a clear
 * ENOENT naming the missing path.
 */
export function resolveBundledTemplateDir(): string {
  const candidates = [
    join(process.resourcesPath ?? "", "template"),
    join(__dirname, "..", "..", "resources", "template"),
    join(process.cwd(), "apps", "desktop", "resources", "template"),
    join(process.cwd(), "resources", "template"),
  ]
  for (const dir of candidates) {
    if (existsSync(dir)) {
      return dir
    }
  }
  return candidates[0] ?? join(__dirname, "..", "..", "resources", "template")
}

/**
 * The writable template copy under the data dir (`~/.pi-lab/template`, or the
 * `PI_LAB_DATA_DIR` override). This is the directory the Settings editor and
 * `projects.createFromTemplate` read/write — never the bundled original.
 */
export function resolveWritableTemplateDir(): string {
  return join(resolveDataDir(), "template")
}

/**
 * Seed the writable template from the bundled one — **only when it doesn't yet
 * exist**, so it is idempotent and never overwrites the user's edits. Symlinks
 * (e.g. `CLAUDE.md` -> `AGENTS.md`) are preserved verbatim, and editor/VCS cruft
 * (`.DS_Store`, any nested `.git`) is skipped, matching the project-copy path.
 *
 * Called eagerly at boot and lazily by the template router as a safety net. A
 * missing bundled template surfaces as the copy's own ENOENT (no silent failure);
 * the boot caller degrades gracefully by logging rather than aborting.
 */
export async function seedWritableTemplate(): Promise<void> {
  const writable = resolveWritableTemplateDir()
  if (existsSync(writable)) {
    return
  }
  const bundled = resolveBundledTemplateDir()
  await cp(bundled, writable, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const base = basename(src)
      return base !== ".DS_Store" && base !== ".git"
    },
  })
}
