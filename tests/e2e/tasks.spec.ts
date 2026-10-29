import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
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
  await writeFile(
    join(dir, "TODO.md"),
    [
      "# TODO",
      "",
      "## Implementation",
      "",
      "- [ ] Parse human Markdown",
      "",
      "## Experiments",
      "",
      "- [~] Run benchmark #priority/high #label/ml #owner/alex",
      "",
    ].join("\n"),
  )
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-tasks-"))
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
      PI_LAB_TEST_OPEN_PROJECT: repoDir,
    },
  })
})

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("Tasks reads and surgically updates the project's TODO Markdown", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })

  const tasksNav = window.locator('[data-testid="science-nav-item"][data-science-tab="tasks"]')
  await tasksNav.hover()
  await expect(window.getByTestId("sidebar-feature-help-label")).toHaveText("Tasks")
  await expect(window.getByTestId("sidebar-feature-help-description")).toHaveText(
    "Manage every project's TODO Markdown from one list or Kanban.",
  )
  await tasksNav.click()
  await expect(window.getByTestId("science-tasks")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("task-row")).toHaveCount(2)
  await expect(window.getByText("Parse human Markdown")).toBeVisible()
  await expect(window.getByText("#ml")).toBeVisible()
  await expect(window.getByText("Group by", { exact: true })).toHaveCount(0)
  await window.getByRole("button", { name: "No grouping" }).hover()
  await expect(window.getByTestId("sidebar-feature-help-label")).toHaveText("No grouping")
  await expect(window.getByTestId("sidebar-feature-help-description")).toHaveText(
    "Show all tasks in one flat list",
  )

  // List grouping clusters each project's tasks by their nearest Markdown heading.
  await window.getByRole("button", { name: "Group by headings" }).click()
  await expect(window.getByTestId("tasks-heading-list")).toBeVisible()
  await expect(window.getByTestId("task-list-heading")).toHaveText([
    "TODO / Implementation",
    "TODO / Experiments",
  ])
  await window.getByRole("button", { name: "No grouping" }).click()

  // Heading Kanban follows the document structure and includes both sections.
  await window.getByRole("button", { name: "Kanban view" }).click()
  await expect(window.getByTestId("tasks-heading-board")).toBeVisible()
  await expect(window.getByText("TODO / Implementation")).toBeVisible()
  await expect(window.getByText("TODO / Experiments")).toBeVisible()

  // A single visible heading stays capped instead of stretching to its task's max-content width.
  await window.getByRole("button", { name: "Hide TODO / Experiments column" }).click()
  const singleHeadingWidth = await window
    .getByRole("group", { name: "TODO / Implementation" })
    .evaluate((column) => column.getBoundingClientRect().width)
  expect(singleHeadingWidth).toBeLessThanOrEqual(360)
  await window
    .getByRole("button", {
      name: "Restore hidden columns for repo (1 hidden, 1 task in hidden columns)",
    })
    .click()
  await window
    .getByRole("menuitemcheckbox", {
      name: "Show TODO / Experiments column (1 task)",
    })
    .click()

  // Kanban columns wrap at narrow widths, and cards stay inside their own non-overlapping column.
  await window.setViewportSize({ width: 800, height: 700 })
  await window.getByRole("button", { name: "Group by Kanban" }).click()
  const stageLayout = await window.getByTestId("tasks-status-board").evaluate((board) => {
    const columns = [...board.querySelectorAll('[data-testid="adaptive-board-grid"] > fieldset')]
    return {
      columnCount: columns.length,
      scrollWidth: board.parentElement?.scrollWidth ?? 0,
      clientWidth: board.parentElement?.clientWidth ?? 0,
      columns: columns.map((column) => {
        const bounds = column.getBoundingClientRect()
        const card = column.querySelector('[data-testid="task-card"]')?.getBoundingClientRect()
        return {
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          bottom: bounds.bottom,
          width: bounds.width,
          cardLeft: card?.left ?? null,
          cardRight: card?.right ?? null,
        }
      }),
    }
  })
  expect(stageLayout.columnCount).toBe(3)
  for (const lane of ["Todo", "In Progress", "Done"]) {
    await expect(window.getByRole("heading", { name: lane })).toBeVisible()
  }
  await expect(window.getByRole("button", { name: "Hide Todo column" })).toHaveCount(0)
  expect(stageLayout.scrollWidth).toBeLessThanOrEqual(stageLayout.clientWidth + 1)
  for (const [index, geometry] of stageLayout.columns.entries()) {
    expect(geometry.width).toBeLessThanOrEqual(360)
    for (const other of stageLayout.columns.slice(index + 1)) {
      const separated =
        geometry.right <= other.left ||
        other.right <= geometry.left ||
        geometry.bottom <= other.top ||
        other.bottom <= geometry.top
      expect(separated).toBe(true)
    }
    if (geometry.cardLeft !== null) {
      expect(geometry.cardLeft).toBeGreaterThanOrEqual(geometry.left)
      expect(geometry.cardRight).toBeLessThanOrEqual(geometry.right)
    }
  }

  // Return to the default list and complete one task through the UI.
  await window.getByRole("button", { name: "List" }).click()
  await window.getByRole("button", { name: "Mark done" }).first().click()
  await expect
    .poll(async () => readFile(join(repoDir, "TODO.md"), "utf8"))
    .toMatch(/- \[x\] Parse human Markdown #id\/[a-f0-9]{12} #status\/done/)
  await expect(window.getByText("Parse human Markdown")).toBeHidden()
  await window.getByRole("button", { name: "Show done" }).click()
  await expect(window.getByText("Parse human Markdown")).toBeVisible()

  // Creating a task writes it to TODO.md rather than an application database.
  await window.getByRole("button", { name: "New task" }).click()
  await window.getByLabel("Title").fill("Write the report")
  await window.getByLabel("Details").fill("Summarize the benchmark results.")
  await window.getByRole("button", { name: "Save" }).click()
  await expect
    .poll(async () => readFile(join(repoDir, "TODO.md"), "utf8"))
    .toContain("Write the report")
  await expect(window.getByText("Write the report")).toBeVisible()
})
