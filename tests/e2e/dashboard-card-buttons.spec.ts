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

// The Settings > Dashboard card buttons list, through the real Electron build,
// IPC and SQLite settings row, including an app restart on the same data folder.

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional real packaged app verification.
const packagedBinary = process.env.PI_LAB_PACKAGED_BINARY

let dataDir: string
let repoDir: string

/** Initialize a repo with one commit on `main`, deterministic identity. */
async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", dir])
  const run = (args: string[]) => execFileAsync("git", ["-C", dir, ...args])
  await run(["config", "user.email", "test@pi-lab.local"])
  await run(["config", "user.name", "PI Lab Test"])
  await writeFile(join(dir, "README.md"), "# fixture\n")
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

async function launchApp(): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: packagedBinary ?? ELECTRON_PATH,
    args: packagedBinary ? [] : [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: repoDir,
      PI_LAB_TEST_AGENT_ID: "test-echo",
    },
  })
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-card-buttons-"))
  repoDir = join(dataDir, "repo")
  await initRepo(repoDir)
})

test.afterEach(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("Settings > Dashboard chooses the project card buttons and the choice survives a restart", async () => {
  let app = await launchApp()
  let window = await app.firstWindow()
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })
  let card = window.getByTestId("project-card")
  await expect(card).toBeVisible({ timeout: 30_000 })

  // Default: Tasks, Analysis and LaTeX Editor are buttons; Auto-research is in the menu.
  await expect(card.getByTestId("project-card-tasks")).toBeVisible()
  await expect(card.getByTestId("project-card-analysis")).toBeVisible()
  await expect(card.getByTestId("project-card-latex")).toBeVisible()
  await expect(card.getByTestId("project-card-auto-research")).toHaveCount(0)
  await card.getByTestId("project-card-body").click({ button: "right", position: { x: 24, y: 24 } })
  const menu = window.getByTestId("project-card-menu")
  await expect(menu.getByTestId("project-card-menu-auto-research")).toBeEnabled()
  await expect(menu.getByTestId("project-card-menu-analysis")).toHaveCount(0)
  await window.keyboard.press("Escape")
  await expect(menu).toHaveCount(0)

  // Turn Auto-research on and Analysis off in Settings > Dashboard.
  await window.getByTestId("nav-settings").click()
  await window.getByTestId("settings-nav-dashboard").click()
  const auto = window.getByTestId("settings-card-button-auto-research")
  const analysis = window.getByTestId("settings-card-button-analysis")
  await expect(auto).toHaveAttribute("aria-checked", "false")
  await expect(analysis).toHaveAttribute("aria-checked", "true")
  await auto.click()
  await expect(auto).toHaveAttribute("aria-checked", "true")
  await analysis.click()
  await expect(analysis).toHaveAttribute("aria-checked", "false")
  await window.getByTestId("settings-back").click()

  const expectChangedCard = async () => {
    await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })
    card = window.getByTestId("project-card")
    await expect(card.getByTestId("project-card-auto-research")).toBeVisible({ timeout: 30_000 })
    await expect(card.getByTestId("project-card-analysis")).toHaveCount(0)
    await card
      .getByTestId("project-card-body")
      .click({ button: "right", position: { x: 24, y: 24 } })
    const changedMenu = window.getByTestId("project-card-menu")
    await expect(changedMenu.getByTestId("project-card-menu-analysis")).toBeVisible()
    await expect(changedMenu.getByTestId("project-card-menu-auto-research")).toHaveCount(0)
    await window.keyboard.press("Escape")
  }
  await expectChangedCard()

  // Restart with the same data folder: the choice is read back from SQLite.
  await app.close()
  app = await launchApp()
  window = await app.firstWindow()
  await expectChangedCard()
  await app.close()
})
