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
  type Locator,
  type Page,
  test,
} from "./fixtures/playwright"

/**
 * Accent app themes in the real Electron build (a source run, so the Alpha theme
 * list): picking one in Settings colors the panel card borders and the panel
 * titles with the accent, while a plain theme keeps the quiet border.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

const execFileAsync = promisify(execFile)

let app: ElectronApplication
let dataDir: string

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
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-app-themes-"))
  const repoDir = join(dataDir, "repo")
  await initRepo(repoDir)
  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_TEST_HIDE_WINDOWS: "1",
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

/** Pick a theme in Settings → Appearance and go back to the fixture project. */
async function pickTheme(window: Page, themeId: string): Promise<void> {
  await window.getByTestId("nav-settings").click()
  await window.getByTestId("settings-nav-appearance").click()
  await window.getByTestId(`settings-app-theme-${themeId}`).click()
  await expect(window.getByTestId(`settings-app-theme-${themeId}`)).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await window.getByTestId("settings-back").click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
}

/** A CSS custom property of the root element, resolved to the `rgb(...)` form computed styles use. */
async function rootColor(window: Page, property: string): Promise<string> {
  return window.evaluate((name) => {
    const probe = document.createElement("span")
    probe.style.color = `var(${name})`
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, property)
}

async function style(locator: Locator, property: "borderTopColor" | "color"): Promise<string> {
  return locator.evaluate((node, name) => getComputedStyle(node)[name], property)
}

test("an accent theme colors the panel card borders and panel titles", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })

  await pickTheme(window, "neon-pink")
  const panel = window.getByTestId("central-panel")
  const rightPanel = window.getByTestId("right-sidebar")
  await window.getByTestId("panel-tab-files").click()
  const filesTitle = window.getByTestId("file-tree-root")
  await expect(filesTitle).toBeVisible()

  const accent = await rootColor(window, "--panel-border")
  const quiet = await rootColor(window, "--border")
  expect(accent).not.toBe(quiet)
  expect(await style(panel, "borderTopColor")).toBe(accent)
  expect(await style(rightPanel, "borderTopColor")).toBe(accent)
  expect(await style(filesTitle, "color")).toBe(await rootColor(window, "--panel-title"))
  expect(await style(filesTitle, "color")).not.toBe(await rootColor(window, "--muted-foreground"))

  // A plain theme leaves the accent tokens unset: quiet card borders and muted titles.
  await pickTheme(window, "nord")
  await window.getByTestId("panel-tab-files").click()
  expect(await style(panel, "borderTopColor")).toBe(await rootColor(window, "--border"))
  expect(await style(filesTitle, "color")).toBe(await rootColor(window, "--muted-foreground"))
})
