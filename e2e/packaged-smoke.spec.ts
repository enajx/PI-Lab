import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

/**
 * Packaged-app smoke (git history (build phases) P11 / AGENTS.md Pitfalls #4): launch the REAL packaged
 * `Skipper.app` — not `out/main/index.js` — and assert it boots to `app-ready`.
 *
 * This is the only test that proves native modules load from the *packaged* app:
 * better-sqlite3 (DB init + migrate on boot) and node-pty (its `.node` +
 * `spawn-helper` in `app.asar.unpacked`) must resolve via the real app's
 * asar-aware resolver, with the Electron ABI. If the ABI were wrong or a native
 * module were missing/un-unpacked, boot would fail before `app-ready`.
 *
 * It's GATED on the packaged build existing (`release/mac-arm64/Skipper.app`) and
 * skips otherwise, so it never breaks `bun run e2e` on a checkout that only ran
 * `bun run build`. Build it with `bun run package` (or `--cwd apps/desktop package`).
 *
 * MUST run under Node (not Bun) — Playwright's `_electron` launcher hangs under
 * the Bun runtime (docs/testing-and-build.md (build & ship)).
 */

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "apps", "desktop")

/** The packaged macOS binary (the `--dir`/dmg build output for this host). */
const PACKAGED_BINARY = join(
  DESKTOP_DIR,
  "release",
  "mac-arm64",
  "Skipper.app",
  "Contents",
  "MacOS",
  "Skipper",
)

let app: ElectronApplication
let dataDir: string
let repoDir: string

async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", dir])
  const run = (args: string[]) => execFileAsync("git", ["-C", dir, ...args])
  await run(["config", "user.email", "test@skipper.local"])
  await run(["config", "user.name", "Skipper Test"])
  await writeFile(join(dir, "README.md"), "# fixture\n")
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

// Only meaningful once the packaged app exists; otherwise skip (don't fail).
test.skip(
  !existsSync(PACKAGED_BINARY),
  `packaged app not built (run: bun run package) — ${PACKAGED_BINARY}`,
)

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "skipper-pkg-smoke-"))
  repoDir = join(dataDir, "repo")
  await initRepo(repoDir)

  app = await electron.launch({
    // Launch the PACKAGED binary itself — no `args` main entry; the packaged app
    // resolves its own main from its package.json.
    executablePath: PACKAGED_BINARY,
    env: {
      ...process.env,
      SKIPPER_TEST_MODE: "1",
      SKIPPER_DATA_DIR: dataDir,
      SKIPPER_SOCKET_PATH: join(dataDir, "daemon.sock"),
      SKIPPER_TEST_OPEN_PROJECT: repoDir,
    },
  })
})

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("packaged Skipper.app boots with native modules (better-sqlite3 + node-pty)", async () => {
  const window = await app.firstWindow()

  // Boot gate — reaching this proves DB init + migrate ran (better-sqlite3 loaded
  // under the Electron ABI from app.asar.unpacked).
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 60_000 })

  // The dashboard is the home surface; the opened repo shows as a project card —
  // proving the packaged renderer + main + DB round-trip works.
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 60_000 })
  await expect(window.getByTestId("project-card")).toContainText("repo", { timeout: 60_000 })
})
