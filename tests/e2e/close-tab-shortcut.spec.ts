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
 * closes the focused file tab (asking first when it is dirty); with no file tab
 * focused the app moves to the background. The menu item is clicked from main,
 * the same handler the Command+W accelerator runs. The tab × uses the same prompt.
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

test("Cmd+W with no file tab focused moves the app to the background", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("central-launcher")).toBeVisible()
  await pressCmdW()
  await expect.poll(isHidden).toBe(true)
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((win) => !win.isDestroyed()),
    ),
  ).toBe(true)
})
