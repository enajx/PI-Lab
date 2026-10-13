import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = join(here, "..", "apps", "desktop")
const mainEntry = join(desktopDir, "out", "main", "index.js")
const electronPath = createRequire(join(desktopDir, "package.json"))("electron") as string

let app: ElectronApplication
let dataDir: string

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-setup-e2e-"))
  app = await electron.launch({
    executablePath: electronPath,
    args: [mainEntry],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
    },
  })
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

  const wizard = window.getByTestId("project-setup-wizard")
  await expect(wizard.getByRole("heading", { name: "Configuración del proyecto" })).toBeVisible()
  await expect(wizard.getByLabel("Descripción breve")).toBeVisible()
  await expect(wizard.getByLabel("Tipo de proyecto")).toHaveValue("")
  await expect(wizard.getByLabel("Tipo de proyecto").locator('option[value=""]')).toHaveText(
    "Elegir tipo de proyecto",
  )
  await expect(
    wizard.getByLabel("Tipo de proyecto").locator('option[value="research"]'),
  ).toHaveText("Proyecto de investigación")
  await expect(
    wizard.getByLabel("Tipo de proyecto").locator('option[value="software"]'),
  ).toHaveText("Proyecto de software")
  await expect(wizard.getByLabel("Tipo de proyecto").locator('option[value="paper"]')).toHaveText(
    "Artículo",
  )
  await expect(wizard.getByText("Markdown de tareas")).toBeVisible()
  await wizard.getByRole("button", { name: "Configurar más tarde" }).click()
  await expect(wizard).toHaveCount(0)
})

test("creates a project, reviews an interactive CLI proposal, and applies both files", async () => {
  const existingStages = new Set(
    (await readdir(tmpdir())).filter((name) => name.startsWith("pi-lab-plan-")),
  )
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("dashboard-add-project").click()
  await window.getByTestId("add-project-template").click()
  await window.getByTestId("add-project-template-name").fill("Setup study")
  await window.getByTestId("add-project-template-location").fill(dataDir)
  await window.getByRole("button", { name: "Create project" }).click()

  const wizard = window.getByTestId("project-setup-wizard")
  await expect(wizard).toBeVisible({ timeout: 30_000 })
  await expect(wizard.getByLabel("Project type")).toHaveValue("")
  await wizard.getByLabel("Short description").fill("Measure a signal.")
  await wizard.getByLabel("Project type").selectOption("paper")
  const taskChoice = wizard.getByTestId("project-markdown-choice-tasks")
  await taskChoice.getByRole("textbox", { name: "Task Markdown path" }).fill("TODO.md")
  await taskChoice.getByRole("button", { name: "Select" }).click()
  await expect(taskChoice).toContainText("Task source: TODO.md")
  await wizard.getByLabel("Instructions for this project's agents").fill("Use SI units.")
  await wizard.getByLabel("CLI agent").selectOption("test-plan")
  await wizard.getByLabel("Draft mode").selectOption("interactive")
  await wizard.getByRole("button", { name: "Draft RESEARCH.md" }).click()
  await expect(wizard.getByText("Planning agent")).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(async () => {
      const newStages = (await readdir(tmpdir())).filter(
        (name) => name.startsWith("pi-lab-plan-") && !existingStages.has(name),
      )
      return newStages.some((name) => existsSync(join(tmpdir(), name, "PROPOSED_RESEARCH.md")))
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
  expect(await readFile(join(repoDir, "TODO.md"), "utf8")).toContain("# TODO")
})

test("runs a one-shot CLI draft and applies its reviewed proposal", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("dashboard-add-project").click()
  await window.getByTestId("add-project-template").click()
  await window.getByTestId("add-project-template-name").fill("One-shot study")
  await window.getByTestId("add-project-template-location").fill(dataDir)
  await window.getByRole("button", { name: "Create project" }).click()

  const wizard = window.getByTestId("project-setup-wizard")
  await expect(wizard).toBeVisible({ timeout: 30_000 })
  await expect(wizard.getByLabel("Project type")).toHaveValue("")
  await wizard.getByLabel("Short description").fill("Track a measurement.")
  const taskChoice = wizard.getByTestId("project-markdown-choice-tasks")
  await taskChoice.getByRole("textbox", { name: "Task Markdown path" }).fill("TODO.md")
  await taskChoice.getByRole("button", { name: "Select" }).click()
  await expect(taskChoice).toContainText("Task source: TODO.md")
  await expect(wizard.getByRole("button", { name: "Draft RESEARCH.md" })).toBeDisabled()
  await wizard.getByLabel("Project type").selectOption("research")
  await wizard.getByLabel("Instructions for this project's agents").fill("First rule.")
  await wizard.getByLabel("CLI agent").selectOption("test-plan")
  await wizard.getByLabel("Draft mode").selectOption("one-shot")
  await wizard.getByRole("button", { name: "Draft RESEARCH.md" }).click()
  await expect(wizard.getByText("Review project files")).toBeVisible({ timeout: 30_000 })
  await expect(wizard.getByLabel("RESEARCH.md diff").getByText("# Planned project")).toBeVisible()
  await wizard.getByRole("button", { name: "Apply" }).click()
  await expect(wizard).toHaveCount(0)
  expect(await readFile(join(dataDir, "One-shot study", "RESEARCH.md"), "utf8")).toContain(
    "# Planned project",
  )

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
  const wizard = window.getByTestId("project-setup-wizard")
  await expect(wizard.getByLabel("Project type")).toHaveValue("")
  await wizard.getByRole("button", { name: "Set up later" }).click()

  const cardType = window.locator('[data-testid^="project-card-type-"]')
  await expect(cardType).toHaveValue("")
  await cardType.selectOption("software")
  await expect(cardType).toHaveValue("software")
  await window.getByTestId("project-card-open").click()

  const viewType = window.getByTestId("project-view-type")
  await expect(viewType).toHaveValue("software")
  await viewType.selectOption("paper")
  await expect(viewType).toHaveValue("paper")

  await window.getByTestId("nav-settings").click()
  await window.getByTestId("settings-nav-project-view").click()
  const settingsType = window.getByTestId("settings-project-type")
  await expect(settingsType).toHaveValue("paper")
  await settingsType.selectOption("research")
  await expect(settingsType).toHaveValue("research")
})
