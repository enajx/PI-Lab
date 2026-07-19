import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

/**
 * Whole-app E2E (md/engineering/testing-and-build.md, P9) for the Automations / Workflows feature:
 * launch the real Electron build, open a temp git repo as a project via the
 * `?openProject` seam (no native dialog), navigate to the Workflows view from
 * the sidebar, create an automation through the UI, and assert it appears in the
 * list with its cadence summary and persisted execution mode.
 *
 * Scheduling/firing is covered exhaustively by the unit + integration tests
 * (scheduler with an injected clock + fake fire, dispatch overlap guard, runNow
 * through the real session-start flow) — this E2E proves only that the UI is
 * wired end to end to the real main-process router.
 *
 * MUST run under Node (not Bun) — Playwright's `_electron` launcher hangs under
 * Bun (md/engineering/testing-and-build.md (build & ship)); the repo `e2e` script runs Playwright's CLI through node.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

const execFileAsync = promisify(execFile)

let app: ElectronApplication
let dataDir: string
let repoDir: string

async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", dir])
  const run = (args: string[]) => execFileAsync("git", ["-C", dir, ...args])
  await run(["config", "user.email", "test@pi-lab.local"])
  await run(["config", "user.name", "PI Lab Test"])
  await writeFile(join(dir, "README.md"), "# fixture\n")
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-auto-"))
  repoDir = join(dataDir, "repo")
  await initRepo(repoDir)

  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      // Open the temp repo as a project on load so a workflow has a target.
      PI_LAB_TEST_OPEN_PROJECT: repoDir,
    },
  })
})

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("create a workflow via the UI and see it in the list", async () => {
  const window = await app.firstWindow()

  // Boot gate.
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  // The `?openProject` seam opens the repo so it can be selected in the form.
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })

  // Navigate to the Workflows view via the sidebar nav.
  await window.getByTestId("nav-automations").click()
  await expect(window.getByTestId("automations-view")).toBeVisible({ timeout: 30_000 })

  // Empty to start.
  await expect(window.getByTestId("automations-empty")).toBeVisible({ timeout: 30_000 })

  // Open the create form (enabled once the project + agents have loaded).
  const newButton = window.getByTestId("new-automation")
  await expect(newButton).toBeEnabled({ timeout: 30_000 })
  await newButton.click()

  const form = window.getByTestId("create-automation-form")
  await expect(form).toBeVisible()

  // Fill in the name; project + agent default to the first option, the schedule
  // defaults to the daily preset.
  await window.getByTestId("automation-name-input").fill("Nightly sweep")
  await window.getByTestId("automation-prompt").fill("review the latest results")
  await window.getByTestId("automation-execution-mode").selectOption("noninteractive")

  // The schedule preview reflects the default daily preset.
  await expect(window.getByTestId("schedule-preview-summary")).toContainText("Daily", {
    timeout: 30_000,
  })

  // Submit.
  await window.getByTestId("create-automation-submit").click()

  // The new automation appears in the list with its name and cadence summary.
  const row = window.getByTestId("automation-row")
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("automation-name")).toContainText("Nightly sweep")
  await expect(window.getByTestId("schedule-summary")).toContainText("Daily")
  await expect(window.getByTestId("automation-row-execution-mode")).toHaveValue("noninteractive")

  // It is enabled by default and shows a next-run time (not paused).
  await expect(row).toHaveAttribute("data-enabled", "true")

  // Row editing persists the execution choice through the real main-process
  // router and survives a full renderer reload.
  await window.getByTestId("automation-row-execution-mode").selectOption("interactive")
  await expect(window.getByTestId("automation-row-execution-mode")).toHaveValue("interactive")
  await window.reload()
  await expect(window.getByTestId("automations-view")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("automation-row-execution-mode")).toHaveValue("interactive")
})
