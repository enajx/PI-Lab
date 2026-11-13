import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional screenshot path for a review.
const PIN_MENU_SCREENSHOT = process.env.PI_LAB_PIN_MENU_SCREENSHOT

let app: ElectronApplication
let dataDir: string

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-analysis-panel-tabs-"))
  const repoDir = join(dataDir, "repo")
  await mkdir(join(repoDir, "notes"), { recursive: true })
  await execFileAsync("git", ["init", "-b", "main", repoDir])
  await writeFile(join(repoDir, "notes", "plan.md"), "# Plan\n\nPinned plan notes.\n")
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
 * Real app: the Analysis right panel opens with only Sessions, Files and Diary. The
 * pin menu lists every tab with whether it is shown; showing Research is kept after a
 * reload; the menu's file search still pins a Markdown file as a tab.
 */
test("Analysis right panel shows Sessions, Files and Diary, and the pin menu shows more tabs", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  await expect(window.getByTestId("science-analysis")).toBeVisible({ timeout: 30_000 })

  const panel = window.getByTestId("science-sessions")
  const tabs = panel.getByRole("tab")
  await expect(tabs).toHaveText(["Sessions", "Files", "Diary"], { timeout: 30_000 })

  await panel.getByTestId("right-sidebar-pin").click()
  const menu = panel.getByTestId("pin-menu")
  await expect(menu).toBeVisible()
  const rows = menu.getByRole("menuitemcheckbox")
  await expect(rows).toHaveText(["Sessions", "Files", "Research", "TODOs", "Diary"])
  for (const [id, checked] of [
    ["sessions", "true"],
    ["files", "true"],
    ["research", "false"],
    ["todos", "false"],
    ["diary", "true"],
  ]) {
    await expect(menu.getByTestId(`pin-menu-tab-${id}`)).toHaveAttribute("aria-checked", checked)
  }
  await expect(menu.getByTestId("pin-menu-search")).toBeFocused()
  // Compact: inside the right panel, not a wide dialog.
  const menuBox = await menu.boundingBox()
  const panelBox = await panel.boundingBox()
  if (!menuBox || !panelBox) throw new Error("No pin menu layout")
  expect(menuBox.x).toBeGreaterThanOrEqual(panelBox.x)
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width)
  if (PIN_MENU_SCREENSHOT) await window.screenshot({ path: PIN_MENU_SCREENSHOT })

  await menu.getByTestId("pin-menu-tab-research").click()
  await expect(menu.getByTestId("pin-menu-tab-research")).toHaveAttribute("aria-checked", "true")
  await expect(tabs).toHaveText(["Sessions", "Files", "Research", "Diary"])
  await window.keyboard.press("Escape")
  await expect(menu).toHaveCount(0)

  // The reload stays on Analysis.
  await window.reload()
  await expect(window.getByTestId("science-analysis")).toBeVisible({ timeout: 30_000 })
  await expect(tabs).toHaveText(["Sessions", "Files", "Research", "Diary"], { timeout: 30_000 })

  // The file search pins a Markdown file as a shown tab.
  await panel.getByTestId("right-sidebar-pin").click()
  await window.keyboard.type("plan")
  await expect(menu.getByTestId("pin-menu-result")).toHaveAttribute(
    "data-rel-path",
    "notes/plan.md",
    { timeout: 30_000 },
  )
  await window.keyboard.press("Enter")
  await expect(menu).toHaveCount(0)
  await expect(tabs).toHaveText(["Sessions", "Files", "Research", "Diary", "plan.md"])
  await panel.getByTestId("panel-tab-pinned:notes/plan.md").click()
  await expect(panel.getByTestId("panel-pinned:notes/plan.md")).toContainText("Pinned plan notes")
})
