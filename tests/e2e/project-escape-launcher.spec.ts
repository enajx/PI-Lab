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
  type Page,
  test,
} from "./fixtures/playwright"

/**
 * Project view keyboard and empty-state layout, in the real Electron build:
 * - the empty central panel's launcher sits about a third of the way down the panel;
 * - Escape returns to the Projects Dashboard;
 * - Escape in a terminal, or with a menu open, stays in the project view.
 */

// Allowed distance between the launcher content's vertical center and the line a
// third of the way down the panel's empty area. Centered or stuck under the tab bar
// is far outside it.
const CENTER_TOLERANCE_PX = 24
// Time for a navigation Escape could have started to show.
const SETTLE_MS = 500

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

const execFileAsync = promisify(execFile)

let app: ElectronApplication
let dataDir: string

/** Initialize a throwaway git repo with one commit on `main`. */
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
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-project-escape-"))
  const repoDir = join(dataDir, "repo")
  await initRepo(repoDir)
  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
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

/** Open the fixture project and wait for the empty central panel. */
async function openProject(): Promise<Page> {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("central-launcher")).toBeVisible({ timeout: 30_000 })
  return window
}

test("the empty central panel shows its launcher a third of the way down", async () => {
  const window = await openProject()
  const boxes = await window.getByTestId("central-launcher").evaluate((launcher) => {
    const panel = launcher.closest('[data-testid="central-panel"]')
    const group =
      launcher.closest(".dv-content-container") ?? launcher.closest(".dv-watermark-container")
    if (!panel || !group) throw new Error("launcher is not inside the central panel's dock")
    const content = launcher.querySelector('[data-testid="central-launcher-content"]')
    const [first, last] = [content?.firstElementChild, content?.lastElementChild]
    if (!first || !last) throw new Error("launcher has no content")
    const area = group.getBoundingClientRect()
    return {
      panel: panel.getBoundingClientRect().toJSON(),
      area: area.toJSON(),
      contentTop: first.getBoundingClientRect().top,
      contentBottom: last.getBoundingClientRect().bottom,
    }
  })
  // The empty area lies inside the central panel.
  expect(boxes.area.top).toBeGreaterThanOrEqual(boxes.panel.top)
  expect(boxes.area.bottom).toBeLessThanOrEqual(boxes.panel.bottom + 1)
  const contentCenter = (boxes.contentTop + boxes.contentBottom) / 2
  const third = boxes.area.top + (boxes.area.bottom - boxes.area.top) / 3
  expect(Math.abs(contentCenter - third)).toBeLessThanOrEqual(CENTER_TOLERANCE_PX)
})

test("Escape in the project view returns to the Projects Dashboard", async () => {
  const window = await openProject()
  await window.keyboard.press("Escape")
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 10_000 })
  await expect(window.getByTestId("project-view")).toHaveCount(0)
})

test("Escape with the add-pane menu open closes the menu and stays", async () => {
  const window = await openProject()
  await window.getByTestId("central-add-menu").click()
  await expect(window.getByTestId("central-add-menu-options")).toBeVisible()
  await window.keyboard.press("Escape")
  await expect(window.getByTestId("central-add-menu-options")).toHaveCount(0)
  await window.waitForTimeout(SETTLE_MS)
  await expect(window.getByTestId("project-view")).toBeVisible()
  await expect(window.getByTestId("dashboard")).toHaveCount(0)
})

test("Escape in a terminal stays in the project view", async () => {
  const window = await openProject()
  await window.getByTestId("launcher-terminal").click()
  const terminal = window.getByTestId("terminal")
  await expect(terminal).toBeVisible({ timeout: 30_000 })
  await terminal.click()
  await expect(terminal.locator(".xterm-helper-textarea")).toBeFocused()
  await window.keyboard.press("Escape")
  await window.waitForTimeout(SETTLE_MS)
  await expect(window.getByTestId("project-view")).toBeVisible()
  await expect(window.getByTestId("dashboard")).toHaveCount(0)
  await expect(terminal.locator(".xterm-helper-textarea")).toBeFocused()
})
