import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-project-documents-"))
  repoDir = join(dataDir, "repo")
  await mkdir(join(repoDir, "notes"), { recursive: true })
  await execFileAsync("git", ["init", "-b", "main", repoDir])
  await writeFile(join(repoDir, "RESEARCH.md"), "# Default research\n")
  await writeFile(join(repoDir, "notes", "Overview.md"), "# Selected overview\n")
  await writeFile(join(repoDir, "notes", "Work.md"), "# Work\n- [ ] Nested task\n")
  await execFileAsync("git", ["-C", repoDir, "add", "."])
  await execFileAsync("git", [
    "-C",
    repoDir,
    "-c",
    "user.name=PI Lab Test",
    "-c",
    "user.email=test@pi-lab.local",
    "commit",
    "-m",
    "initial",
  ])
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

test("selects nested task and main Markdown files through the real app", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await window.getByTestId("panel-tab-todos").click()
  const taskChoice = window.getByTestId("project-markdown-choice-tasks")
  await taskChoice.getByRole("textbox", { name: "Task Markdown path" }).fill("notes/Work.md")
  await taskChoice.getByRole("button", { name: "Select" }).click()
  await expect(window.getByTestId("panel-todos")).toContainText("Nested task")

  await window.locator('[data-testid="science-nav-item"][data-science-tab="tasks"]').click()
  await expect(window.getByTestId("task-row")).toContainText("Nested task")

  await window.getByTestId("project-item").click()
  await window.getByTestId("panel-tab-files").click()
  await window.getByTestId("file-tree-dir").filter({ hasText: "notes" }).click()
  const overview = window.getByTestId("file-tree-file").filter({ hasText: "Overview.md" })
  await overview.click({ button: "right" })
  await window.getByTestId("file-tree-set-main").click()
  await window.getByTestId("panel-tab-research").click()
  await expect(window.getByTestId("panel-research")).toContainText("Selected overview")

  await window.getByTestId("nav-settings").click()
  await window.getByTestId("settings-nav-project-view").click()
  await expect(window.getByTestId("project-markdown-choice-main")).toContainText(
    "notes/Overview.md",
  )

  await window.getByTestId("settings-back").click()
  await window.reload()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await window.getByTestId("panel-tab-research").click()
  await expect(window.getByTestId("panel-research")).toContainText("Selected overview")
  await window.getByTestId("panel-tab-todos").click()
  await expect(window.getByTestId("panel-todos")).toContainText("Nested task")
})

test("creates an empty TODO.md when the project template has no task file", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await window.getByTestId("panel-tab-todos").click()
  await window
    .getByTestId("project-markdown-choice-tasks")
    .getByRole("button", { name: "Create TODO.md" })
    .click()

  await expect(window.getByTestId("panel-todos")).toContainText("TODO", { timeout: 30_000 })
  expect(await readFile(join(repoDir, "TODO.md"), "utf8")).toBe("")
})

test("copies the configured task template bytes when creating TODO.md", async () => {
  const template = Buffer.from("# Custom tasks\r\n\r\n- [ ] Measure café signal\r\n", "utf8")
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await mkdir(join(dataDir, "template"), { recursive: true })
  await writeFile(join(dataDir, "template", "TODO.md"), template)
  await window.getByTestId("project-item").click()
  await window.getByTestId("panel-tab-todos").click()
  await window
    .getByTestId("project-markdown-choice-tasks")
    .getByRole("button", { name: "Create TODO.md" })
    .click()

  const taskPath = join(repoDir, "TODO.md")
  await expect.poll(() => existsSync(taskPath)).toBe(true)
  expect(await readFile(taskPath)).toEqual(template)
  await expect(window.getByTestId("panel-todos")).toContainText("Measure café signal")
})
