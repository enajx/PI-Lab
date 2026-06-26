import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

/**
 * Whole-app E2E (docs/testing-and-build.md, P7b): launch the real Electron build, boot to
 * `app-ready`, and prove the project-cards Dashboard is wired end-to-end:
 *
 *   1. the `?openProject` seam opens a temp repo on load (via the sidebar),
 *   2. the dashboard (the shell home) shows a project card carrying that
 *      project's name, with a status badge, and
 *   3. the card-size slider is present in the dashboard toolbar.
 *
 * Driven by the test seam in `mainWindow.ts` (env → renderer query param):
 * `SKIPPER_TEST_OPEN_PROJECT`. No native dialog, no agent launch needed here.
 *
 * MUST run under Node (not Bun) — Playwright's `_electron` launcher hangs under
 * Bun (docs/testing-and-build.md (build & ship)).
 */

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

let app: ElectronApplication
let dataDir: string
let repoDir: string

/** Initialize a repo with one commit on `main`, deterministic identity. */
async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", dir])
  const run = (args: string[]) => execFileAsync("git", ["-C", dir, ...args])
  await run(["config", "user.email", "test@skipper.local"])
  await run(["config", "user.name", "Skipper Test"])
  await writeFile(join(dir, "README.md"), "# fixture\n")
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "skipper-e2e-dash-"))
  repoDir = join(dataDir, "repo")
  await initRepo(repoDir)

  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      SKIPPER_TEST_MODE: "1",
      SKIPPER_DATA_DIR: dataDir,
      SKIPPER_SOCKET_PATH: join(dataDir, "daemon.sock"),
      // Open the temp repo as a project on load (via the renderer query seam).
      SKIPPER_TEST_OPEN_PROJECT: repoDir,
    },
  })
})

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("dashboard shows a project card and the size slider", async () => {
  const window = await app.firstWindow()

  // Boot gate.
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  // The home surface is the dashboard.
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })

  // The `?openProject` seam opens the repo; the dashboard then shows a card for
  // it carrying its name (the repo folder is "repo").
  const card = window.getByTestId("project-card")
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).toContainText("repo")

  // It carries a status badge, and the card-size slider is in the toolbar.
  await expect(window.getByTestId("project-card-status")).toBeVisible()
  await expect(window.getByTestId("card-size-slider")).toBeVisible()
})
