import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "./fixtures/playwright"

/**
 * Whole-app E2E: the project the user last opened or clicked (project view,
 * Dashboard card, sidebar) or picked in a science view is the one Tasks,
 * Analysis, LaTeX Editor and Skills open on.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string
// Delta is added first, so it is not the first project in the list (the old fallback).
const NAMES = ["delta", "bravo", "charlie", "alpha"]

let app: ElectronApplication
let dataDir: string

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-current-project-"))
  for (const name of NAMES) {
    await mkdir(join(dataDir, name))
    await writeFile(join(dataDir, name, "TODO.md"), `# ${name}\n\n- [ ] A ${name} task\n`)
  }
  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: join(dataDir, NAMES[0] ?? ""),
    },
  })
})

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

/** Add a project through the renderer's `?openProject` test seam (reloads the window). */
async function addProject(page: Page, name: string, count: number): Promise<void> {
  await Promise.all([
    page.waitForEvent("load"),
    page.evaluate(
      (path) => {
        const url = new URL(window.location.href)
        url.searchParams.set("openProject", path)
        window.location.assign(url.toString())
      },
      join(dataDir, name),
    ),
  ])
  await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("project-item")).toHaveCount(count)
}

async function openScienceTab(page: Page, tab: string): Promise<void> {
  await page.locator(`[data-testid="science-nav-item"][data-science-tab="${tab}"]`).click()
  await expect(page.getByTestId(`science-${tab}`)).toBeVisible()
}

async function pick(page: Page, testId: string, name: string): Promise<void> {
  await page.getByTestId(testId).click()
  await page.getByRole("option", { name, exact: true }).click()
  await expect(page.getByTestId(testId)).toHaveText(name)
}

test("Tasks, Analysis, LaTeX Editor and Skills open on the last opened or picked project", async () => {
  test.setTimeout(120_000)
  const page = await app.firstWindow()
  await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("project-item")).toHaveCount(1)
  await addProject(page, "bravo", 2)
  await addProject(page, "charlie", 3)
  await addProject(page, "alpha", 4)

  // In project bravo, Tasks shows bravo (not All projects).
  await page.getByTestId("project-item").filter({ hasText: "bravo" }).click()
  await expect(page.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await openScienceTab(page, "tasks")
  await expect(page.getByTestId("tasks-project-select")).toHaveText("bravo")

  // All projects in Tasks holds while no other project is opened.
  await pick(page, "tasks-project-select", "All projects")
  await openScienceTab(page, "skills")
  await openScienceTab(page, "tasks")
  await expect(page.getByTestId("tasks-project-select")).toHaveText("All projects")

  // An older pick in Analysis does not win over a project opened from the Dashboard.
  await openScienceTab(page, "analysis")
  await pick(page, "analysis-project-select", "alpha")
  await page.getByTestId("nav-dashboard").click()
  await page
    .getByTestId("project-card")
    .filter({ hasText: "charlie" })
    .getByTestId("project-card-body")
    .click()
  await expect(page.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await openScienceTab(page, "analysis")
  await expect(page.getByTestId("analysis-project-select")).toHaveText("charlie")

  // A project picked in one science view carries to the next.
  await openScienceTab(page, "latex")
  await expect(page.getByTestId("latex-project-select")).toHaveText("charlie")
  await pick(page, "latex-project-select", "delta")
  await openScienceTab(page, "skills")
  await expect(page.getByTestId("skills-project-select")).toHaveText("delta")
  await openScienceTab(page, "tasks")
  await expect(page.getByTestId("tasks-project-select")).toHaveText("delta")
})
