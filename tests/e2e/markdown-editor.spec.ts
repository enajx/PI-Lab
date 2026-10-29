import { execFile } from "node:child_process"
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

const MARKDOWN_FILE = "SPONSOR.md"
const PROJECT_LINK_FILE = "data/results.csv"
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
    join(dir, MARKDOWN_FILE),
    [
      "# Sponsor kit",
      "",
      "Everything a potential sponsor needs.",
      "",
      "## The audience",
      "",
      "| Stat | Value |",
      "| --- | --- |",
      "| Subscribers | 4,213 |",
      "",
    ].join("\n"),
  )
  await mkdir(join(dir, "data"))
  await writeFile(join(dir, PROJECT_LINK_FILE), "subscribers,4213\n")
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-markdown-"))
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

test("edits Markdown in Render and Source with formatting and slash tools", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("panel-tab-files").click()
  await window.getByTestId("file-tree-file").filter({ hasText: MARKDOWN_FILE }).click()

  const buffer = window.getByTestId("editor-buffer")
  const content = buffer.locator(".cm-content")
  await expect(buffer).toBeVisible({ timeout: 30_000 })
  await expect(window.getByRole("button", { name: "Render Markdown" })).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await expect(buffer.locator(".cm-md-heading-1")).toContainText("# Sponsor kit")
  await expect(buffer.locator(".cm-md-heading-2")).toContainText("## The audience")
  await expect(buffer.locator(".cm-md-table").first()).toBeVisible()
  await expect(buffer.locator(".cm-md-source-mark").first()).toBeVisible()

  await content.click()
  await window.keyboard.press("ControlOrMeta+Home")
  await window.keyboard.press("ArrowRight")
  await window.keyboard.press("ArrowRight")
  for (let index = 0; index < 7; index += 1) await window.keyboard.press("Shift+ArrowRight")
  await expect(window.getByRole("toolbar", { name: "Markdown formatting" })).toBeVisible()
  await window.getByRole("button", { name: "Bold" }).click()

  await content.click()
  await window.keyboard.press("ControlOrMeta+End")
  await window.keyboard.press("Enter")
  await window.keyboard.press("Enter")
  await window.keyboard.type("/table")
  const slashMenu = window.getByRole("listbox", { name: "Markdown blocks" })
  await expect(slashMenu).toBeVisible()
  await expect(slashMenu.getByRole("option", { name: "Table" })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await window.keyboard.press("Enter")

  await content.click()
  await window.keyboard.press("ControlOrMeta+End")
  await window.keyboard.press("Enter")
  await window.keyboard.type("/link")
  await expect(slashMenu.getByRole("option", { name: "Link" })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await window.keyboard.press("Enter")
  await expect(content).toContainText("@")

  await window.getByRole("button", { name: "Source Markdown" }).click()
  await expect(window.getByRole("button", { name: "Source Markdown" })).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await expect(buffer.locator(".cm-md-heading-1")).toHaveCount(0)
  await expect(content).toContainText("# **Sponsor** kit")

  await window.getByRole("button", { name: "Render Markdown" }).click()
  await expect(buffer.locator(".cm-md-heading-1")).toBeVisible()
  await content.click()
  await window.keyboard.press("ControlOrMeta+s")

  await expect
    .poll(async () => readFile(join(repoDir, MARKDOWN_FILE), "utf8"), { timeout: 30_000 })
    .toContain("**Sponsor**")
  const saved = await readFile(join(repoDir, MARKDOWN_FILE), "utf8")
  expect(saved).toContain("| Column 1 | Column 2 |")
  expect(saved).toContain("@")
})

test("typed @ and the Link command complete project files as Markdown links", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("panel-tab-files").click()
  await window.getByTestId("file-tree-file").filter({ hasText: MARKDOWN_FILE }).click()

  const content = window.getByTestId("editor-buffer").locator(".cm-content")
  await content.click()
  await window.keyboard.press("ControlOrMeta+End")
  await window.keyboard.press("Enter")
  await window.keyboard.type("@res")
  const fileMenu = window.getByRole("listbox", { name: "Project files" })
  await expect(fileMenu.getByRole("option", { name: PROJECT_LINK_FILE })).toBeVisible()
  await window.keyboard.press("Enter")
  await expect(content).toContainText("[results.csv](data/results.csv)")

  await window.keyboard.press("Enter")
  await window.keyboard.type("/link")
  await window.keyboard.press("Enter")
  await window.keyboard.type("res")
  await expect(fileMenu.getByRole("option", { name: PROJECT_LINK_FILE })).toBeVisible()
  await window.keyboard.press("Enter")
  await window.keyboard.press("ControlOrMeta+s")
  await expect
    .poll(async () => readFile(join(repoDir, MARKDOWN_FILE), "utf8"), { timeout: 30_000 })
    .toContain("[results.csv](data/results.csv)\n[results.csv](data/results.csv)")
})
