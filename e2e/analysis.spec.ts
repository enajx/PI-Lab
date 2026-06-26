import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

/**
 * Whole-app E2E (docs/testing-and-build.md, P8c): launch the real Electron build, open a
 * temp git repo as a project via the `?openProject` seam (no native dialog),
 * navigate to the Analysis science tab, select the CSV the repo contains, and
 * prove the preview table renders end to end.
 *
 * MUST run under Node (not Bun) — Playwright's `_electron` launcher hangs under
 * Bun (docs/testing-and-build.md (build & ship)); the repo `e2e` script runs Playwright's CLI through node.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

const execFileAsync = promisify(execFile)

const CSV_REL_PATH = "data/metrics.csv"
// A non-metric CSV (second column non-numeric) so the preview renders as a TABLE.
// A two-numeric-column series like `epoch,loss` is now auto-detected as a metric
// chart (see discover.ts detectScalarChart), which renders a chart, not a table.
const CSV_BODY = "epoch,label\n0,start\n1,middle\n2,end\n"

let app: ElectronApplication
let dataDir: string
let repoDir: string

/** Initialize a throwaway git repo with one commit and a CSV on `main`. */
async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", dir])
  const run = (args: string[]) => execFileAsync("git", ["-C", dir, ...args])
  await run(["config", "user.email", "test@skipper.local"])
  await run(["config", "user.name", "Skipper Test"])
  await writeFile(join(dir, "README.md"), "# fixture\n")

  // A data file the Analysis tab should discover and preview as a table.
  await mkdir(join(dir, "data"), { recursive: true })
  await writeFile(join(dir, CSV_REL_PATH), CSV_BODY)

  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "skipper-e2e-analysis-"))
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
      // Open the temp repo as a project on load (renderer query seam).
      SKIPPER_TEST_OPEN_PROJECT: repoDir,
    },
  })
})

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("analysis tab previews a CSV discovered in the opened project", async () => {
  const window = await app.firstWindow()

  // Boot gate.
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  // The `?openProject` seam opens the repo; it shows in the sidebar.
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })

  // Navigate to the Analysis science tab via the sidebar nav.
  const analysisNav = window.locator(
    '[data-testid="science-nav-item"][data-science-tab="analysis"]',
  )
  await expect(analysisNav).toBeVisible({ timeout: 30_000 })
  await analysisNav.click()

  // The tab renders, defaulting to the just-opened project.
  await expect(window.getByTestId("science-analysis")).toBeVisible({ timeout: 30_000 })

  // The repo's CSV appears in the file list.
  const fileRow = window.locator(`[data-testid="analysis-file"][data-rel-path="${CSV_REL_PATH}"]`)
  await expect(fileRow).toBeVisible({ timeout: 30_000 })

  // Selecting it renders the preview table.
  await fileRow.click()
  const table = window.getByTestId("analysis-preview-table")
  await expect(table).toBeVisible({ timeout: 30_000 })
  // The header row reflects the CSV's columns.
  await expect(table.locator("thead th")).toHaveCount(2)
  await expect(table.locator("thead th").first()).toHaveText("epoch")
})
