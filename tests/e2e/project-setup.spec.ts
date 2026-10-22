import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
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
} from "@playwright/test"

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = join(here, "..", "..", "apps", "desktop")
const mainEntry = join(desktopDir, "out", "main", "index.js")
const electronPath = createRequire(join(desktopDir, "package.json"))("electron") as string

let app: ElectronApplication
let dataDir: string

async function launchApp(): Promise<void> {
  app = await electron.launch({
    executablePath: electronPath,
    args: [mainEntry],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "PI Lab Test",
      GIT_AUTHOR_EMAIL: "test@pi-lab.local",
      GIT_COMMITTER_NAME: "PI Lab Test",
      GIT_COMMITTER_EMAIL: "test@pi-lab.local",
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
    },
  })
}

async function confirmDetails(window: Page): Promise<void> {
  await window.getByTestId("add-project-confirm").click()
  await expect(window.getByTestId("add-project-dialog")).toHaveCount(0)
}

async function openPlanning(window: Page): Promise<void> {
  await window.getByTestId("project-item").click()
  await window.getByTestId("nav-settings").click()
  await window.getByTestId("settings-nav-project-view").click()
  await window.getByRole("button", { name: "Plan this project" }).click()
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-setup-e2e-"))
  await launchApp()
})

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("project creation and basic setup follow the selected interface language", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("nav-settings").click()
  await window.getByTestId("settings-interface-language").selectOption("es")
  await window.getByTestId("settings-back").click()
  await window.getByTestId("dashboard-add-project").click()
  await expect(window.getByTestId("add-project-template")).toContainText("Empezar desde plantilla")
  await window.getByTestId("add-project-template").click()
  await window.getByTestId("add-project-template-name").fill("Estudio")
  await window.getByTestId("add-project-template-location").fill(dataDir)
  await window.getByRole("button", { name: "Crear proyecto" }).click()

  const details = window.getByTestId("add-project-dialog")
  await expect(details.getByLabel("Nombre del proyecto")).toHaveValue("Estudio")
  await expect(details.getByTestId("edit-project-type")).toHaveCount(0)
  await expect(window.getByTestId("project-setup-wizard")).toHaveCount(0)
  await confirmDetails(window)
})

test("creates a project, reviews an interactive CLI proposal, and applies both files", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("dashboard-add-project").click()
  await window.getByTestId("add-project-template").click()
  await window.getByTestId("add-project-template-name").fill("Setup study")
  await window.getByTestId("add-project-template-location").fill(dataDir)
  await window.getByRole("button", { name: "Create project" }).click()

  await confirmDetails(window)
  await openPlanning(window)
  const wizard = window.getByTestId("project-setup-wizard")
  await expect(wizard).toBeVisible({ timeout: 30_000 })
  await expect(wizard.getByLabel("Project type")).toHaveValue("")
  await wizard.getByLabel("Short description").fill("Measure a signal.")
  await wizard.getByLabel("Project type").selectOption("manuscript")
  const taskChoice = wizard.getByTestId("project-markdown-choice-tasks")
  await taskChoice.getByRole("textbox", { name: "Task Markdown path" }).fill("TODO.md")
  await taskChoice.getByRole("button", { name: "Create TODO.md" }).click()
  await expect(taskChoice).toContainText("Task source: TODO.md")
  await wizard.getByLabel("Instructions for this project's agents").fill("Use SI units.")
  await wizard.getByLabel("CLI agent").selectOption("test-plan")
  await wizard.getByLabel("Draft mode").selectOption("interactive")
  await wizard.getByRole("button", { name: "Draft RESEARCH.md" }).click()
  await expect(wizard.getByText("Planning agent")).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(async () => {
      const drafts = await readdir(join(dataDir, "planning"))
      return drafts.some((name) =>
        existsSync(join(dataDir, "planning", name, "stage", "PROPOSED_RESEARCH.md")),
      )
    })
    .toBe(true)
  await wizard.getByRole("button", { name: "Review proposal" }).click()
  await expect(wizard.getByText("Review project files")).toBeVisible({ timeout: 30_000 })
  await expect(wizard.getByLabel("RESEARCH.md diff").getByText("# Planned project")).toBeVisible()
  await expect(wizard.getByLabel("AGENTS.md diff").getByText("Use SI units.")).toBeVisible()
  await wizard.getByRole("button", { name: "Apply" }).click()
  await expect(wizard).toHaveCount(0)

  const repoDir = join(dataDir, "Setup study")
  expect(await readFile(join(repoDir, "RESEARCH.md"), "utf8")).toContain("# Planned project")
  expect(await readFile(join(repoDir, "AGENTS.md"), "utf8")).toContain("Use SI units.")
  expect(await readFile(join(repoDir, "TODO.md"), "utf8")).toBe("")
})

test("runs a one-shot CLI draft and applies its reviewed proposal", async () => {
  let window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("dashboard-add-project").click()
  await window.getByTestId("add-project-template").click()
  await window.getByTestId("add-project-template-name").fill("One-shot study")
  await window.getByTestId("add-project-template-location").fill(dataDir)
  await window.getByRole("button", { name: "Create project" }).click()

  await confirmDetails(window)
  await openPlanning(window)
  let wizard = window.getByTestId("project-setup-wizard")
  await expect(wizard).toBeVisible({ timeout: 30_000 })
  await expect(wizard.getByLabel("Project type")).toHaveValue("")
  await wizard.getByLabel("Short description").fill("Track a measurement.")
  const taskChoice = wizard.getByTestId("project-markdown-choice-tasks")
  await taskChoice.getByRole("textbox", { name: "Task Markdown path" }).fill("TODO.md")
  await taskChoice.getByRole("button", { name: "Create TODO.md" }).click()
  await expect(taskChoice).toContainText("Task source: TODO.md")
  await wizard.getByLabel("Project type").selectOption("research")
  await wizard.getByLabel("Instructions for this project's agents").fill("First rule.")
  await wizard.getByLabel("CLI agent").selectOption("test-plan")
  await wizard.getByLabel("Draft mode").selectOption("one-shot")
  await wizard.getByRole("button", { name: "Draft RESEARCH.md" }).click()
  await expect(wizard.getByText("Review project files")).toBeVisible({ timeout: 30_000 })
  await expect(wizard.getByLabel("RESEARCH.md diff").getByText("# Planned project")).toBeVisible()
  // Reopen the real app before applying: draft identity and review must survive.
  await app.close()
  await launchApp()
  window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  if (await window.getByTestId("nav-settings").isVisible())
    await window.getByTestId("nav-settings").click()
  await window.getByTestId("settings-nav-project-view").click()
  await window.getByRole("button", { name: "Plan this project" }).click()
  wizard = window.getByTestId("project-setup-wizard")
  await expect(wizard.getByText("Review project files")).toBeVisible({ timeout: 30_000 })
  await expect(wizard.getByLabel("RESEARCH.md diff").getByText("# Planned project")).toBeVisible()
  await wizard.getByRole("button", { name: "Apply" }).click()
  await expect(wizard).toHaveCount(0)
  expect(await readFile(join(dataDir, "One-shot study", "RESEARCH.md"), "utf8")).toContain(
    "# Planned project",
  )

  if (await window.getByTestId("nav-settings").isVisible())
    await window.getByTestId("nav-settings").click()
  await window.getByTestId("settings-nav-project-view").click()
  await window.getByRole("button", { name: "Plan this project" }).click()
  await expect(wizard).toBeVisible()
  await wizard.getByLabel("Short description").fill("Refine the description.")
  await expect(wizard.getByLabel("Instructions for this project's agents")).toHaveValue(
    "First rule.",
  )
  await wizard.getByLabel("Instructions for this project's agents").fill("Second rule.")
  await wizard.getByLabel("CLI agent").selectOption("test-plan")
  await wizard.getByRole("button", { name: "Draft RESEARCH.md" }).click()
  await expect(wizard.getByText("Review project files")).toBeVisible({ timeout: 30_000 })
  await expect(wizard.getByLabel("AGENTS.md diff").getByText("First rule.")).toHaveAttribute(
    "data-change",
    "removed",
  )
  await expect(wizard.getByLabel("AGENTS.md diff").getByText("Second rule.")).toHaveAttribute(
    "data-change",
    "added",
  )
  await wizard.getByRole("button", { name: "Apply" }).click()
  await expect(wizard).toHaveCount(0)
  const agents = await readFile(join(dataDir, "One-shot study", "AGENTS.md"), "utf8")
  expect(agents).toContain("Second rule.")
  expect(agents).not.toContain("First rule.")
  expect(agents.match(/## PI Lab project instructions:/g)).toHaveLength(1)
})

test("chooses and changes a project type from Dashboard, Project view, and Settings", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("dashboard-add-project").click()
  await window.getByTestId("add-project-template").click()
  await window.getByTestId("add-project-template-name").fill("Type choices")
  await window.getByTestId("add-project-template-location").fill(dataDir)
  await window.getByRole("button", { name: "Create project" }).click()
  await confirmDetails(window)
  await expect(window.locator('[data-testid^="project-card-type-"]')).toHaveCount(0)
  await window
    .getByTestId("project-card-body")
    .click({ button: "right", position: { x: 24, y: 24 } })
  await window.getByTestId("project-card-menu-edit").click()
  await window.getByTestId("edit-project-type").selectOption("software")
  await window.getByTestId("edit-project-save").click()
  await expect(window.getByTestId("edit-project-dialog")).toHaveCount(0)
  await window.getByTestId("project-card-open").click()

  const viewType = window.getByTestId("project-view-type")
  await expect(viewType).toHaveValue("software")
  await viewType.selectOption("manuscript")
  await expect(viewType).toHaveValue("manuscript")

  if (await window.getByTestId("nav-settings").isVisible())
    await window.getByTestId("nav-settings").click()
  await window.getByTestId("settings-nav-project-view").click()
  const settingsType = window.getByTestId("settings-project-type")
  await expect(settingsType).toHaveValue("manuscript")
  await settingsType.selectOption("research")
  await expect(settingsType).toHaveValue("research")
})
