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
  type Page,
  test,
} from "./fixtures/playwright"

/**
 * macOS Cmd+W in the project view: the native menu item asks the renderer, which
 * closes the active tab (asking first when it is a dirty file, an agent or a
 * terminal). Cmd+W never hides or closes the window; with no tab open it does
 * nothing. The menu item is clicked from main, the same handler the Command+W
 * accelerator runs. The tab × uses the same file prompt.
 */

const SEED_FILE = "close-me.txt"
const SEED_CONTENT = "original line\n"
const APPENDED = "APPENDED-BY-E2E"
// Longer than main's wait for the renderer's answer (1.5 s), so a fallback would show.
const FALLBACK_WINDOW_MS = 2_500

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

const execFileAsync = promisify(execFile)

let app: ElectronApplication
let dataDir: string
let repoDir: string

/** Initialize a throwaway git repo with one commit on `main` and the seed file. */
async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", dir])
  const run = (args: string[]) => execFileAsync("git", ["-C", dir, ...args])
  await run(["config", "user.email", "test@pi-lab.local"])
  await run(["config", "user.name", "PI Lab Test"])
  await writeFile(join(dir, "README.md"), "# fixture\n")
  await writeFile(join(dir, SEED_FILE), SEED_CONTENT)
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

test.beforeEach(async () => {
  test.skip(process.platform !== "darwin", "macOS app shortcut")
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-close-tab-"))
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

/** Run the native Window-menu item bound to Command+W. */
async function pressCmdW(): Promise<void> {
  const clicked = await app.evaluate(({ Menu }) => {
    const items = Menu.getApplicationMenu()?.items.flatMap((item) => item.submenu?.items ?? [])
    const item = items?.find((entry) => entry.accelerator === "Command+W")
    if (!item) return false
    item.click()
    return true
  })
  expect(clicked).toBe(true)
}

async function isHidden(): Promise<boolean> {
  return app.evaluate(({ app }) => app.isHidden())
}

/** Open the project and focus the seed file in the central editor. */
async function openSeedFile(): Promise<Page> {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await window.getByTestId("panel-tab-files").click()
  await window.getByTestId("file-tree-file").filter({ hasText: SEED_FILE }).click()
  await expect(window.getByTestId("editor-buffer")).toBeVisible()
  await expect(window.getByTestId("central-tab")).toHaveCount(1)
  return window
}

test("Cmd+W closes the focused saved file and keeps the app visible", async () => {
  const window = await openSeedFile()
  await pressCmdW()
  await expect(window.getByTestId("central-tab")).toHaveCount(0)
  await expect(window.getByTestId("central-launcher")).toBeVisible()
  await window.waitForTimeout(FALLBACK_WINDOW_MS)
  expect(await isHidden()).toBe(false)
})

test("Cmd+W on a dirty file asks first; Cancel keeps it and Discard closes it", async () => {
  const window = await openSeedFile()
  await window.getByTestId("editor-buffer").locator(".cm-content").click()
  await window.keyboard.press("ControlOrMeta+End")
  await window.keyboard.type(APPENDED)
  await expect(window.getByTestId("central-tab-dirty")).toBeVisible()

  await pressCmdW()
  const prompt = window.getByTestId("close-file-prompt")
  await expect(prompt).toBeVisible()
  await expect(prompt).toContainText(SEED_FILE)
  await prompt.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(prompt).toHaveCount(0)
  await expect(window.getByTestId("central-tab-dirty")).toBeVisible()
  await expect(window.getByTestId("editor-buffer")).toContainText(APPENDED)

  await pressCmdW()
  await window
    .getByTestId("close-file-prompt")
    .getByRole("button", { name: "Discard", exact: true })
    .click()
  await expect(window.getByTestId("central-tab")).toHaveCount(0)
  expect(await readFile(join(repoDir, SEED_FILE), "utf8")).toBe(SEED_CONTENT)
  await window.waitForTimeout(FALLBACK_WINDOW_MS)
  expect(await isHidden()).toBe(false)
})

test("the tab × on a dirty file asks first; Cancel keeps it and Discard closes it", async () => {
  const window = await openSeedFile()
  await window.getByTestId("editor-buffer").locator(".cm-content").click()
  await window.keyboard.press("ControlOrMeta+End")
  await window.keyboard.type(APPENDED)
  await expect(window.getByTestId("central-tab-dirty")).toBeVisible()

  await window.getByTestId("central-tab-close").click()
  const prompt = window.getByTestId("close-file-prompt")
  await expect(prompt).toBeVisible()
  await prompt.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(prompt).toHaveCount(0)
  await expect(window.getByTestId("central-tab-dirty")).toBeVisible()

  await window.getByTestId("central-tab-close").click()
  await prompt.getByRole("button", { name: "Discard", exact: true }).click()
  await expect(window.getByTestId("central-tab")).toHaveCount(0)
  expect(await readFile(join(repoDir, SEED_FILE), "utf8")).toBe(SEED_CONTENT)
})

/** The window is on screen: the app is not hidden and the user window is visible. */
async function expectWindowVisible(): Promise<void> {
  expect(await isHidden()).toBe(false)
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.isVisible()),
    ),
  ).toBe(true)
}

test("Cmd+W with no tab open does nothing and the window stays visible", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("central-launcher")).toBeVisible()
  await pressCmdW()
  await window.waitForTimeout(FALLBACK_WINDOW_MS)
  await expectWindowVisible()
  await expect(window.getByTestId("central-launcher")).toBeVisible()
})

test("with a file and a terminal open, Cmd+W asks, closes only the terminal, and the window stays visible", async () => {
  const window = await openSeedFile()
  await window.getByTestId("central-add-menu").click()
  await window.getByTestId("central-add-terminal").click()
  await expect(window.getByTestId("central-tab")).toHaveCount(2)
  // Focus inside the terminal, as when the user types in it before pressing Cmd+W.
  await window.locator('[data-testid="terminal"]:visible .xterm-helper-textarea').focus()

  await pressCmdW()
  const prompt = window.getByTestId("close-session-prompt")
  await expect(prompt).toBeVisible()
  await expect(prompt).toContainText("Close terminal?")
  await prompt.getByRole("button", { name: "Close terminal", exact: true }).click()
  await expect(window.getByTestId("central-tab")).toHaveCount(1)
  await expect(window.getByTestId("central-tab")).toHaveAttribute("data-tab-kind", "file")
  await window.waitForTimeout(FALLBACK_WINDOW_MS)
  await expectWindowVisible()
})

test("Cmd+W on an agent tab asks first; Cancel keeps the agent, Stop agent closes it", async () => {
  test.setTimeout(90_000)
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await window.getByTestId("central-add-menu").click()
  await window.getByTestId("central-add-agent").click()
  const chooser = window.getByTestId("new-agent-dialog")
  await chooser.locator("label", { hasText: "Test Waiting" }).click()
  await chooser.getByRole("button", { name: "Start agent" }).click()
  await expect(window.getByTestId("terminal")).toContainText("Do you want to proceed?")
  await window.locator('[data-testid="terminal"]:visible .xterm-helper-textarea').focus()

  await pressCmdW()
  const prompt = window.getByTestId("close-session-prompt")
  await expect(prompt).toContainText("Stop agent?")
  await prompt.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(prompt).toHaveCount(0)
  await expect(window.getByTestId("central-tab")).toHaveAttribute("data-tab-kind", "agent")

  await pressCmdW()
  await prompt.getByRole("button", { name: "Stop agent", exact: true }).click()
  await expect(window.getByTestId("central-tab")).toHaveCount(0)
  await expect(window.getByTestId("central-launcher")).toBeVisible()
  await window.waitForTimeout(FALLBACK_WINDOW_MS)
  await expectWindowVisible()
})

test("⌘1 and ⌘2 switch to the first and second tab", async () => {
  const window = await openSeedFile()
  await window.getByTestId("file-tree-file").filter({ hasText: "README.md" }).click()
  const tabs = window.getByTestId("central-tab")
  await expect(tabs).toHaveCount(2)
  await expect(tabs.nth(1)).toHaveAttribute("data-active", "true")

  await window.keyboard.press("Meta+1")
  await expect(tabs.nth(0)).toHaveAttribute("data-active", "true")
  await expect(tabs.nth(1)).toHaveAttribute("data-active", "false")

  await window.keyboard.press("Meta+2")
  await expect(tabs.nth(1)).toHaveAttribute("data-active", "true")
  // No third tab: ⌘3 changes nothing.
  await window.keyboard.press("Meta+3")
  await expect(tabs.nth(1)).toHaveAttribute("data-active", "true")
})
