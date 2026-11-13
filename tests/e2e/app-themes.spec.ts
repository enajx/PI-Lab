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

/** The saved theme, mode and accent, and the colors the app shows now. */
async function appearance(window: Page) {
  return window.evaluate(() => ({
    savedTheme: localStorage.getItem("pi-lab.appTheme"),
    savedMode: localStorage.getItem("pi-lab.theme"),
    // Each theme keeps its own accent; this is the saved theme's.
    savedAccent: localStorage.getItem(
      `pi-lab.appAccent.${localStorage.getItem("pi-lab.appTheme") ?? "default"}`,
    ),
    dark: document.documentElement.classList.contains("dark"),
    background: document.documentElement.style.getPropertyValue("--background"),
    panelBorder: document.documentElement.style.getPropertyValue("--panel-border"),
  }))
}

/** The palette backdrop's color: a dim at the top level, transparent while previewing. */
async function backdrop(window: Page): Promise<string> {
  return style(window.getByTestId("command-palette-dim"), "backgroundColor")
}

const highlightedItem = (window: Page) =>
  window.locator('[data-testid="command-palette-item"][data-highlighted="true"]')

async function openChooseTheme(window: Page): Promise<void> {
  await window.keyboard.press("ControlOrMeta+Shift+p")
  await expect(window.getByTestId("command-palette")).toBeVisible()
  expect(await backdrop(window)).not.toBe("rgba(0, 0, 0, 0)")
  await window.getByTestId("command-palette-input").fill("Choose theme")
  await expect(window.getByTestId("command-palette-item").first()).toHaveAttribute(
    "data-command-id",
    "settings-choose-theme",
  )
  await window.keyboard.press("Enter")
  // Every theme in both modes, under Light and Dark headers; the current one highlighted.
  await expect(window.getByTestId("command-palette-group")).toHaveText(["Light", "Dark"])
  await expect(highlightedItem(window)).toHaveAttribute("data-command-id", "nord:light")
  // No dim while previewing, so the app shows the theme's real colors.
  expect(await backdrop(window)).toBe("rgba(0, 0, 0, 0)")
}

test("palette Choose theme previews themes in each mode with their own accent, Escape restores, Enter saves", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await pickAppearance(window, "nord", "ember")
  const before = await appearance(window)
  expect(before).toMatchObject({
    savedTheme: "nord",
    savedMode: "light",
    savedAccent: "ember",
    dark: false,
  })
  expect(before.panelBorder).not.toBe("")

  await openChooseTheme(window)
  await window.keyboard.press("ArrowDown")
  await window.keyboard.press("ArrowDown")
  await expect.poll(async () => (await appearance(window)).background).not.toBe(before.background)
  // Previewed with that theme's own accent (none saved), and nothing saved yet.
  expect(await appearance(window)).toMatchObject({
    savedTheme: "nord",
    savedAccent: "ember",
    panelBorder: "",
  })
  await window.keyboard.press("Escape")
  await expect(window.getByTestId("command-palette")).toHaveCount(0)
  await expect.poll(() => appearance(window)).toEqual(before)

  // Nord under Dark previews dark mode without saving it; Enter saves theme and mode and
  // keeps Nord's accent.
  await openChooseTheme(window)
  await window.getByTestId("command-palette-input").fill("Nord")
  await window.keyboard.press("ArrowDown")
  await expect(highlightedItem(window)).toHaveAttribute("data-command-id", "nord:dark")
  await expect.poll(async () => (await appearance(window)).dark).toBe(true)
  expect((await appearance(window)).savedMode).toBe("light")
  await window.keyboard.press("Enter")
  await expect(window.getByTestId("command-palette")).toHaveCount(0)
  await expect
    .poll(async () => {
      const { savedTheme, savedMode, savedAccent, dark, panelBorder } = await appearance(window)
      return { savedTheme, savedMode, savedAccent, dark, panelBorder }
    })
    .toEqual({
      savedTheme: "nord",
      savedMode: "dark",
      savedAccent: "ember",
      dark: true,
      panelBorder: "#ff9a4d",
    })
})

test("palette lists one command per setting and switches Light and Dark mode directly", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const input = window.getByTestId("command-palette-input")
  const labels = () => window.getByTestId("command-palette-item").allTextContents()
  await window.keyboard.press("ControlOrMeta+Shift+p")
  await input.fill("them")
  expect((await labels()).some((label) => label.startsWith("Set "))).toBe(false)
  expect(await labels()).toEqual(expect.arrayContaining(["Choose theme", "Change editor theme"]))
  expect(await labels()).not.toContain("Change theme mode")

  // In Light mode only the switch to Dark is offered, and it applies at once.
  await input.fill("mode")
  expect(await labels()).toContain("Switch to Dark mode")
  expect(await labels()).not.toContain("Switch to Light mode")
  await window.locator('[data-command-id="settings-switch-dark-mode"]').click()
  await expect(window.getByTestId("command-palette")).toHaveCount(0)
  await expect.poll(async () => (await appearance(window)).savedMode).toBe("dark")
  expect((await appearance(window)).dark).toBe(true)

  // A command just used is listed first as recently used when the palette reopens.
  await window.keyboard.press("ControlOrMeta+Shift+p")
  await input.fill("Choose theme")
  await window.keyboard.press("Enter")
  await window.keyboard.press("Escape")
  await window.keyboard.press("ControlOrMeta+Shift+p")
  const top = window.getByTestId("command-palette-item").first()
  await expect(top).toHaveAttribute("data-command-id", "settings-choose-theme")
  await expect(top).toContainText("recently used")
  await expect(top).toHaveAttribute("data-highlighted", "true")
  await input.fill("mode")
  expect(await labels()).toContain("Switch to Light mode")
  expect(await labels()).not.toContain("Switch to Dark mode")
  await window.keyboard.press("Escape")

  // With System mode (set in Settings) both switches are offered.
  await window.getByTestId("nav-settings").click()
  await window.getByTestId("settings-nav-appearance").click()
  await window.getByTestId("settings-theme-mode").selectOption("system")
  await window.keyboard.press("ControlOrMeta+Shift+p")
  await input.fill("mode")
  expect(await labels()).toEqual(
    expect.arrayContaining(["Switch to Dark mode", "Switch to Light mode"]),
  )
  await window.keyboard.press("Escape")
})

test("with an accent, hovering a title bar icon button colors its icon; Theme default does not", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  const button = window.getByTestId("agent-status-control")

  await pickAppearance(window, "nord", "ember")
  await button.hover()
  await expect
    .poll(() => style(button, "color"))
    .toBe(await rootColor(window, "--hover-foreground"))
  expect(await rootColor(window, "--hover-foreground")).not.toBe(
    await rootColor(window, "--foreground"),
  )

  await pickAppearance(window, "nord", "default")
  await button.hover()
  await expect.poll(() => style(button, "color")).toBe(await rootColor(window, "--foreground"))
})
