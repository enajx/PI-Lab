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
 * Theme accents in the real Electron build: picking an accent in Settings colors
 * the panel card borders and the panel titles, while Theme default keeps the
 * theme's quiet border and muted titles.
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

/** Pick a theme and an accent in Settings → Appearance and go back to the fixture project. */
async function pickAppearance(window: Page, themeId: string, accentId: string): Promise<void> {
  await window.getByTestId("nav-settings").click()
  await window.getByTestId("settings-nav-appearance").click()
  for (const testId of [`settings-app-theme-${themeId}`, `settings-app-accent-${accentId}`]) {
    await window.getByTestId(testId).click()
    await expect(window.getByTestId(testId)).toHaveAttribute("aria-pressed", "true")
  }
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

async function style(
  locator: Locator,
  property: "backgroundColor" | "borderTopColor" | "color",
): Promise<string> {
  return locator.evaluate((node, name) => getComputedStyle(node)[name], property)
}

test("an accent colors the panel card borders and panel titles; Theme default does not", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })

  await pickAppearance(window, "nord", "ember")
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

  // Theme default leaves the accent tokens unset: Nord's quiet card border and muted titles.
  await pickAppearance(window, "nord", "default")
  await window.getByTestId("panel-tab-files").click()
  expect(await style(panel, "borderTopColor")).toBe(await rootColor(window, "--border"))
  expect(await style(filesTitle, "color")).toBe(await rootColor(window, "--muted-foreground"))
})

/** The saved theme and accent, and the colors the app shows now. */
async function appearance(window: Page) {
  return window.evaluate(() => ({
    savedTheme: localStorage.getItem("pi-lab.appTheme"),
    savedAccent: localStorage.getItem("pi-lab.appAccent"),
    background: document.documentElement.style.getPropertyValue("--background"),
    panelBorder: document.documentElement.style.getPropertyValue("--panel-border"),
  }))
}

/** The palette backdrop's color: a dim at the top level, transparent while previewing. */
async function backdrop(window: Page): Promise<string> {
  return style(window.getByTestId("command-palette-dim"), "backgroundColor")
}

async function openChangeTheme(window: Page): Promise<void> {
  await window.keyboard.press("ControlOrMeta+Shift+p")
  await expect(window.getByTestId("command-palette")).toBeVisible()
  expect(await backdrop(window)).not.toBe("rgba(0, 0, 0, 0)")
  await window.getByTestId("command-palette-input").fill("Change theme")
  await window.locator('[data-command-id="settings-change-theme"]').click()
  await expect(
    window.locator('[data-testid="command-palette-item"][data-highlighted="true"]'),
  ).toHaveAttribute("data-command-id", "nord")
  // No dim while previewing, so the app shows the theme's real colors.
  expect(await backdrop(window)).toBe("rgba(0, 0, 0, 0)")
}

test("palette Change theme previews themes with Theme default, Escape restores, Enter saves", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await pickAppearance(window, "nord", "ember")
  const before = await appearance(window)
  expect(before).toMatchObject({ savedTheme: "nord", savedAccent: "ember" })
  expect(before.panelBorder).not.toBe("")

  await openChangeTheme(window)
  await window.keyboard.press("ArrowDown")
  await window.keyboard.press("ArrowDown")
  await expect.poll(async () => (await appearance(window)).background).not.toBe(before.background)
  const previewing = await appearance(window)
  // Previewed with Theme default, and nothing saved yet.
  expect(previewing).toMatchObject({ savedTheme: "nord", savedAccent: "ember", panelBorder: "" })

  await window.keyboard.press("Escape")
  await expect(window.getByTestId("command-palette")).toHaveCount(0)
  await expect.poll(() => appearance(window)).toEqual(before)

  await openChangeTheme(window)
  await window.keyboard.press("ArrowDown")
  const highlighted = await window
    .locator('[data-testid="command-palette-item"][data-highlighted="true"]')
    .getAttribute("data-command-id")
  await window.keyboard.press("Enter")
  await expect(window.getByTestId("command-palette")).toHaveCount(0)
  await expect
    .poll(async () => {
      const { savedTheme, savedAccent, panelBorder } = await appearance(window)
      return { savedTheme, savedAccent, panelBorder }
    })
    .toEqual({ savedTheme: highlighted, savedAccent: "default", panelBorder: "" })
})

test("palette lists one Change command per setting and previews theme mode live", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.keyboard.press("ControlOrMeta+Shift+p")
  const input = window.getByTestId("command-palette-input")
  await input.fill("them")
  const labels = await window.getByTestId("command-palette-item").allTextContents()
  expect(labels.some((label) => label.startsWith("Set "))).toBe(false)
  expect(labels).toEqual(
    expect.arrayContaining(["Change theme", "Change theme mode", "Change editor theme"]),
  )

  const dark = () => window.evaluate(() => document.documentElement.classList.contains("dark"))
  const savedMode = () => window.evaluate(() => localStorage.getItem("pi-lab.theme"))
  expect(await dark()).toBe(false)
  await input.fill("Change theme mode")
  await window.keyboard.press("Enter")
  await window.keyboard.press("ArrowDown")
  await expect.poll(dark).toBe(true)
  expect(await savedMode()).toBe("light")
  await window.keyboard.press("Escape")
  await expect.poll(dark).toBe(false)
  expect(await savedMode()).toBe("light")
})
