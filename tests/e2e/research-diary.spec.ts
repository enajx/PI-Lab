import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
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

test("research diary shows today's heading, edits, and saves the file on disk", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()

  const panel = window.getByTestId("research-diary-panel")
  await expect(panel.getByRole("heading", { name: today() })).toBeVisible({ timeout: 30_000 })
  const diaryPath = join(repoDir, "md", "research-diary", "diary.md")
  expect(await readFile(diaryPath, "utf8")).toBe(`## ${today()}\n\n`)

  await panel.getByTestId("research-diary-edit").click()
  const source = panel.locator(".cm-content")
  await expect(source).toBeVisible()
  await source.click()
  await window.keyboard.press("ControlOrMeta+End")
  await window.keyboard.type("Ran the first diary test.")
  await panel.getByTestId("research-diary-save").click()

  await expect(panel.getByTestId("research-diary-rendered")).toContainText(
    "Ran the first diary test.",
  )
  expect(await readFile(diaryPath, "utf8")).toBe(`## ${today()}\n\nRan the first diary test.`)

  // The top-bar button hides the panel and shows it again.
  await window.getByTestId("project-view-research-diary").click()
  await expect(panel).toHaveCount(0)
  await window.getByTestId("project-view-research-diary").click()
  await expect(panel.getByRole("heading", { name: today() })).toBeVisible()
})
