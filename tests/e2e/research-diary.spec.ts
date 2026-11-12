import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
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
const SCREENS = join(HERE, "..", "..", ".cache", "screens")

let app: ElectronApplication
let dataDir: string
let repoDir: string

/** Today's local date as YYYY-MM-DD, the same rule the app uses. */
function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${now.getFullYear()}-${month}-${day}`
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-research-diary-"))
  repoDir = join(dataDir, "repo")
  await mkdir(repoDir, { recursive: true })
  await execFileAsync("git", ["init", "-b", "main", repoDir])
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

/**
 * Real app and IPC: in the project view the diary is the right sidebar's Diary tab.
 * It is edited in place in Preview (the editor's rendered Markdown), shows an
 * unsaved dot, and Cmd+S saves. Opening it writes nothing.
 */
test("research diary shows today's heading, edits in place, and saves the file on disk", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()

  // The diary is the tab after TODOs; the project opens on Files.
  const sidebar = window.getByTestId("right-sidebar")
  await expect(sidebar.getByRole("tab")).toHaveText(["Files", "Research", "TODOs", "Diary"], {
    timeout: 30_000,
  })
  // At the default sidebar width every tab name shows in full.
  for (const tab of await sidebar.getByRole("tab").all()) {
    const cut = await tab.evaluate((element) => element.scrollWidth > element.clientWidth)
    expect(cut).toBe(false)
  }
  const panel = window.getByTestId("research-diary-panel")
  await expect(panel).toHaveCount(0)

  // With the sidebar collapsed, the top bar diary button opens it on the Diary tab.
  await window.getByTestId("right-sidebar-collapse").click()
  await expect(sidebar).toHaveCount(0)
  await window.getByTestId("project-view-research-diary").click()
  await expect(window.getByTestId("panel-tab-diary")).toHaveAttribute("data-active", "true")
  await expect(sidebar.getByTestId("research-diary-panel")).toBeVisible()
  const text = panel.locator(".cm-content")
  await expect(text).toContainText(today(), { timeout: 30_000 })
  // No Edit button: the Markdown view switch starts on Render, and nothing is on disk yet.
  await expect(panel.getByRole("button", { name: "Edit" })).toHaveCount(0)
  await expect(panel.getByRole("button", { name: "Render Markdown" })).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await expect(panel.getByTestId("research-diary-dirty")).toHaveCount(0)
  const diaryPath = join(repoDir, "md", "research-diary", "diary.md")
  await expect(stat(diaryPath)).rejects.toThrow()

  await text.click()
  await window.keyboard.press("ControlOrMeta+End")
  await window.keyboard.type("Ran the first diary test.")
  await expect(panel.getByTestId("research-diary-dirty")).toBeVisible()
  await window.screenshot({ path: join(SCREENS, "project-diary-preview.png") })
  await window.keyboard.press("ControlOrMeta+S")

  await expect(panel.getByTestId("research-diary-dirty")).toHaveCount(0)
  expect(await readFile(diaryPath, "utf8")).toBe(`## ${today()}\n\nRan the first diary test.`)

  // Source shows the same text as plain Markdown.
  await panel.getByRole("button", { name: "Source Markdown" }).click()
  await expect(panel.locator(".cm-editor.cm-md-render")).toHaveCount(0)
  await expect(text).toContainText(`## ${today()}`)
  await expect(text).toContainText("Ran the first diary test.")
  await window.screenshot({ path: join(SCREENS, "project-diary-source.png") })

  // Another tab hides the diary; the top bar button brings it back.
  await window.getByTestId("panel-tab-files").click()
  await expect(panel).toHaveCount(0)
  await window.getByTestId("project-view-research-diary").click()
  await expect(panel.locator(".cm-content")).toContainText(today())
})

/** Real app and IPC: unsaved diary edits are saved when the user leaves the Diary tab. */
test("unsaved diary edits are saved on disk when another tab is opened", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await window.getByTestId("project-view-research-diary").click()
  const panel = window.getByTestId("research-diary-panel")
  const text = panel.locator(".cm-content")
  await expect(text).toContainText(today(), { timeout: 30_000 })
  await text.click()
  await window.keyboard.press("ControlOrMeta+End")
  await window.keyboard.type("Not saved by hand.")
  await expect(panel.getByTestId("research-diary-dirty")).toBeVisible()

  await window.getByTestId("panel-tab-files").click()
  await expect(panel).toHaveCount(0)
  const diaryPath = join(repoDir, "md", "research-diary", "diary.md")
  await expect
    .poll(() => readFile(diaryPath, "utf8").catch(() => ""), { timeout: 10_000 })
    .toBe(`## ${today()}\n\nNot saved by hand.`)
})

/** Real app and IPC: a save drops the day headings that have nothing under them. */
test("saving the diary removes empty day headings already in the file", async () => {
  const diaryDir = join(repoDir, "md", "research-diary")
  await mkdir(diaryDir, { recursive: true })
  const diaryPath = join(diaryDir, "diary.md")
  await writeFile(diaryPath, `## ${today()}\n\n## 2020-01-02\n\n## 2020-01-01\n\nOld entry.\n`)
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await window.getByTestId("project-view-research-diary").click()
  const panel = window.getByTestId("research-diary-panel")
  const text = panel.locator(".cm-content")
  await expect(text).toContainText("Old entry.", { timeout: 30_000 })

  await text.click()
  await window.keyboard.press("ControlOrMeta+End")
  await window.keyboard.type("More.")
  await window.keyboard.press("ControlOrMeta+S")

  await expect(panel.getByTestId("research-diary-dirty")).toHaveCount(0)
  expect(await readFile(diaryPath, "utf8")).toBe("## 2020-01-01\n\nOld entry.\nMore.")
})

/**
 * Real app and IPC: in Analysis the diary is the lower part of the one right
 * panel, below Sessions. The panel starts open with the diary showing. The top
 * bar diary button hides and shows the diary; the divider resizes the diary and
 * its share is saved; collapsing the panel hides both parts. After the diary was
 * hidden with the button, the next visit starts with the panel collapsed, and the
 * button opens it with the diary.
 */
test("Analysis shows the diary below Sessions in one collapsible right panel", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1400, 900))
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  await expect(window.getByTestId("science-analysis")).toBeVisible({ timeout: 30_000 })

  const topBar = window.getByTestId("science-analysis").locator("header").first()
  const add = topBar.getByTestId("analysis-shortcuts-add")
  const picker = topBar.getByTestId("analysis-project-select")
  const analyze = topBar.getByTestId("analysis-analyze-experiments")
  const x = async (locator: typeof add) => (await locator.boundingBox())?.x ?? -1
  await expect(analyze).toBeVisible()
  // The "+" sits left of the project picker, and the buttons show only their icon.
  expect(await x(add)).toBeLessThan(await x(picker))
  expect(await x(picker)).toBeLessThan(await x(analyze))
  for (const testId of [
    "analysis-analyze-experiments",
    "analysis-report",
    "analysis-fetch-experiments",
    "analysis-research-diary",
  ]) {
    await expect(topBar.getByTestId(testId)).toHaveText("")
    expect((await topBar.getByTestId(testId).boundingBox())?.width ?? 0).toBeLessThanOrEqual(30)
  }

  const panel = window.getByTestId("science-sessions")
  const diary = panel.getByTestId("research-diary-panel")
  const diaryButton = topBar.getByTestId("analysis-research-diary")
  // Open by default, with the diary showing.
  await expect(panel).toHaveAttribute("data-collapsed", "false")
  await expect(diaryButton).toHaveAttribute("aria-pressed", "true")
  await expect(diary.locator(".cm-content")).toContainText(today(), { timeout: 30_000 })
  // One card: the project view's right sidebar with a Sessions tab first, on the Diary tab.
  await expect(panel.getByTestId("right-sidebar")).toHaveCount(1)
  await expect(panel.getByRole("tab").first()).toHaveAttribute("data-testid", "panel-tab-sessions")
  await expect(panel.getByTestId("panel-tab-diary")).toHaveAttribute("aria-selected", "true")
  await window.screenshot({ path: join(SCREENS, "analysis-right-panel.png") })

  // The Sessions tab shows the sessions; the diary button shows the Diary tab again.
  await panel.getByTestId("panel-tab-sessions").click()
  await expect(panel.getByTestId("central-panel")).toBeVisible()
  await expect(diaryButton).toHaveAttribute("aria-pressed", "false")
  await diaryButton.click()
  await expect(diary).toBeVisible()
  await expect(diaryButton).toHaveAttribute("aria-pressed", "true")

  // The panel's one collapse button (the sidebar's own) collapses it to a thin bar.
  await panel.getByTestId("right-sidebar-collapse").click()
  await expect(panel).toHaveAttribute("data-collapsed", "true")
  await expect(window.getByTestId("analysis-collapsed-bar")).toBeVisible()
  await expect(diaryButton).toHaveAttribute("aria-pressed", "false")

  // A collapsed panel does not turn the diary off: the next visit opens with it.
  const tasksNav = window.locator('[data-testid="science-nav-item"][data-science-tab="tasks"]')
  const analysisNav = window.locator(
    '[data-testid="science-nav-item"][data-science-tab="analysis"]',
  )
  await tasksNav.click()
  await expect(window.getByTestId("science-tasks")).toBeVisible()
  await analysisNav.click()
  await expect(panel).toHaveAttribute("data-collapsed", "false")
  await expect(diary).toBeVisible()

  // While the Diary tab shows, the button hides the panel.
  await diaryButton.click()
  await expect(panel).toHaveAttribute("data-collapsed", "true")
  await diaryButton.click()
  await expect(diary).toBeVisible()

  // Hiding the diary with the button is saved: the next visit starts collapsed.
  await diaryButton.click()
  await expect(window.getByTestId("research-diary-panel")).toHaveCount(0)
  await tasksNav.click()
  await expect(window.getByTestId("science-tasks")).toBeVisible()
  await analysisNav.click()
  await expect(panel).toHaveAttribute("data-collapsed", "true")
  await diaryButton.click()
  await expect(panel).toHaveAttribute("data-collapsed", "false")
  await expect(diary).toBeVisible()
})
