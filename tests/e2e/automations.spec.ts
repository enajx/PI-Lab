import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  test,
} from "./fixtures/playwright"

/**
 * Checks workflow creation through the real Electron UI and main-process router.
 * Scheduler behavior is covered separately. Playwright's Electron launcher must
 * run under Node, not Bun.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

// biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional packaged Alpha verification.
const packagedBinary = process.env.PI_LAB_PACKAGED_BINARY

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
    executablePath: packagedBinary ?? ELECTRON_PATH,
    args: packagedBinary ? [] : [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: repoDir,
    },
  })
})

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("create a routine via the UI and see it in the list", async () => {
  const window = await app.firstWindow()

  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })

  await expect(window.getByTestId("nav-automations")).toContainText("Routines")
  await window.getByTestId("nav-automations").click()
  await expect(window.getByTestId("automations-view")).toBeVisible({ timeout: 30_000 })

  await expect(window.getByTestId("automations-empty")).toBeVisible({ timeout: 30_000 })

  const newButton = window.getByTestId("new-automation")
  await expect(newButton).toHaveText("New routine")
  await expect(newButton).toBeEnabled({ timeout: 30_000 })
  await newButton.click()

  const form = window.getByTestId("create-automation-form")
  await expect(form).toBeVisible()

  await window.getByTestId("automation-name-input").fill("Nightly sweep")
  await window.getByTestId("automation-prompt").fill("review the latest results")
  await window.getByTestId("automation-execution-mode").selectOption("noninteractive")

  await expect(window.getByTestId("schedule-preview-summary")).toContainText("Daily", {
    timeout: 30_000,
  })

  await window.getByTestId("create-automation-submit").click()

  const row = window.getByTestId("automation-row")
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("automation-name")).toContainText("Nightly sweep")
  await expect(window.getByTestId("schedule-summary")).toContainText("Daily")
  await expect(window.getByTestId("automation-row-execution-mode")).toHaveValue("noninteractive")

  await expect(row).toHaveAttribute("data-enabled", "true")

  // Row editing persists the execution choice through the real main-process
  // router and survives a full renderer reload.
  await window.getByTestId("automation-row-execution-mode").selectOption("interactive")
  await expect(window.getByTestId("automation-row-execution-mode")).toHaveValue("interactive")
  await window.reload()
  await expect(window.getByTestId("automations-view")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("automation-row-execution-mode")).toHaveValue("interactive")
})
