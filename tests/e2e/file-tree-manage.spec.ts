import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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

/**
 * File tree management through the real app: the right-click Delete and ⌘⌫ both
 * confirm, move the entry to the OS Trash (real `shell.trashItem`, so the temp
 * fixture files land in the user's Trash), and close the deleted file's tab.
 * Right-click selects the row and keeps it highlighted while the menu is open.
 * Only one row is highlighted at a time, and a click on a file keeps keyboard
 * focus on its row so ⌘⌫ right after the click asks to delete it.
 * "Don't ask again" makes later ⌘⌫ deletes skip the dialog. The Settings > Editor
 * "Show hidden files" switch hides and shows dotfiles. Uses a temporary project
 * and the test-mode project-opening seam.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

const execFileAsync = promisify(execFile)

let app: ElectronApplication
let dataDir: string
let repoDir: string

/** Initialize a throwaway git repo with one commit on `main` and the seed files. */
async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", dir])
  const run = (args: string[]) => execFileAsync("git", ["-C", dir, ...args])
  await run(["config", "user.email", "test@pi-lab.local"])
  await run(["config", "user.name", "PI Lab Test"])
  await writeFile(join(dir, "README.md"), "# fixture\n")
  await writeFile(join(dir, "RESEARCH.md"), "# Fixture\n\nbody\n")
  await writeFile(join(dir, "delete-me.txt"), "remove this\n")
  await writeFile(join(dir, "key-delete.txt"), "remove with the keyboard\n")
  await writeFile(join(dir, "ask-once.txt"), "confirm once\n")
  await writeFile(join(dir, "no-ask.txt"), "delete without asking\n")
  await writeFile(join(dir, ".env.example"), "A=1\n")
  await writeFile(join(dir, "click-delete.txt"), "delete right after a click\n")
  await mkdir(join(dir, "docs"))
  await writeFile(join(dir, "docs", "guide.md"), "# Guide\n")
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

async function launchApp(): Promise<void> {
  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: repoDir,
      PI_LAB_TEST_AGENT_ID: "test-echo",
    },
  })
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-file-tree-"))
  repoDir = join(dataDir, "repo")
  await initRepo(repoDir)
  await launchApp()
})

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("right-click Delete and ⌘⌫ confirm, trash the file, and close its tab", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("panel-tab-files").click()

  // Open the file first so deleting it must also close its tab.
  const row = window.getByTestId("file-tree-file").filter({ hasText: "delete-me.txt" })
  await row.click()
  await expect(window.getByTestId("central-tab").filter({ hasText: "delete-me.txt" })).toBeVisible({
    timeout: 30_000,
  })

  await row.click({ button: "right" })
  const menu = window.getByTestId("file-tree-context-menu")
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Open",
    "Reveal in Finder",
    "Copy Path",
    "Copy Relative Path",
    "Rename",
    "Duplicate",
    "Delete",
  ])
  await menu.getByRole("menuitem", { name: "Delete" }).click()
  const dialog = window.getByRole("alertdialog")
  await expect(dialog).toContainText("delete-me.txt")
  await dialog.getByRole("button", { name: "Move to Trash" }).click()

  await expect(row).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(() => exists(join(repoDir, "delete-me.txt"))).toBe(false)
  await expect(window.getByTestId("central-tab").filter({ hasText: "delete-me.txt" })).toHaveCount(
    0,
  )

  // ⌘⌫ on a focused row runs the same confirmed delete.
  const keyRow = window.getByTestId("file-tree-file").filter({ hasText: "key-delete.txt" })
  await keyRow.focus()
  await window.keyboard.press("Meta+Backspace")
  await expect(window.getByRole("alertdialog")).toContainText("key-delete.txt")
  await window.keyboard.press("Enter")
  await expect(keyRow).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(() => exists(join(repoDir, "key-delete.txt"))).toBe(false)
})

test("right-click selects the row and keeps it highlighted while the menu is open", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("panel-tab-files").click()

  const row = window.getByTestId("file-tree-file").filter({ hasText: "RESEARCH.md" })
  await row.click({ button: "right" })
  const menu = window.getByTestId("file-tree-context-menu")
  await expect(menu).toBeVisible()
  await expect(row).toHaveAttribute("data-selected", "true")
  await expect(row).toHaveAttribute("data-menu-open", "true")
  // Right-click does not open the file.
  await expect(window.getByTestId("central-tab").filter({ hasText: "RESEARCH.md" })).toHaveCount(0)

  // Moving the pointer into the menu keeps the row's highlight.
  const shade = () => row.evaluate((element) => getComputedStyle(element).backgroundColor)
  await menu.getByRole("menuitem", { name: "Copy Path" }).hover()
  await expect(row).toHaveAttribute("data-menu-open", "true")
  expect(await shade()).not.toBe("rgba(0, 0, 0, 0)")

  await window.keyboard.press("Escape")
  await expect(menu).toHaveCount(0)
  await expect(row).not.toHaveAttribute("data-menu-open", "true")
  await expect(row).toHaveAttribute("data-selected", "true")
})

test("a click keeps focus on the file row so ⌘⌫ asks to delete it", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("panel-tab-files").click()

  // The click opens the file; the editor mounts without taking focus from the row.
  const row = window.getByTestId("file-tree-file").filter({ hasText: "click-delete.txt" })
  await row.click()
  await expect(
    window.getByTestId("central-tab").filter({ hasText: "click-delete.txt" }),
  ).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("editor-buffer")).toBeVisible({ timeout: 30_000 })
  await expect(row).toBeFocused()
  await window.keyboard.press("Meta+Backspace")
  const dialog = window.getByRole("alertdialog")
  await expect(dialog).toContainText("click-delete.txt")
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => exists(join(repoDir, "click-delete.txt"))).toBe(true)
})

test("only one tree row is highlighted after folder click, file click, and right-click", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("panel-tab-files").click()

  const rows = window.locator('[data-testid="file-tree-dir"], [data-testid="file-tree-file"]')
  const selected = () =>
    rows.evaluateAll((elements) =>
      elements
        .filter((element) => element.getAttribute("data-selected") === "true")
        .map((element) => element.getAttribute("data-rel-path")),
    )
  // Rows with a background shade; the hovered row may be shaded too, so it must be the selected one.
  const shaded = () =>
    rows.evaluateAll((elements) =>
      elements
        .filter((element) => getComputedStyle(element).backgroundColor !== "rgba(0, 0, 0, 0)")
        .map((element) => element.getAttribute("data-rel-path")),
    )

  await window.getByTestId("file-tree-dir").filter({ hasText: "docs" }).click()
  await expect.poll(selected).toEqual(["docs"])
  await expect.poll(shaded).toEqual(["docs"])

  await window.getByTestId("file-tree-file").filter({ hasText: "README.md" }).click()
  await expect.poll(selected).toEqual(["README.md"])
  await expect.poll(shaded).toEqual(["README.md"])

  // Right-click another file while README.md is the editor's active file.
  await window.getByTestId("file-tree-file").filter({ hasText: "RESEARCH.md" }).click({
    button: "right",
  })
  await expect(window.getByTestId("file-tree-context-menu")).toBeVisible()
  await expect.poll(selected).toEqual(["RESEARCH.md"])
  await expect.poll(shaded).toEqual(["RESEARCH.md"])
})

test("Don't ask again makes later ⌘⌫ deletes skip the confirmation", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("panel-tab-files").click()

  const first = window.getByTestId("file-tree-file").filter({ hasText: "ask-once.txt" })
  await first.focus()
  await window.keyboard.press("Meta+Backspace")
  const dialog = window.getByRole("alertdialog")
  await expect(dialog).toContainText("ask-once.txt")
  await dialog.getByRole("checkbox", { name: "Don't ask again" }).check()
  await dialog.getByRole("button", { name: "Move to Trash" }).click()
  await expect(first).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(() => exists(join(repoDir, "ask-once.txt"))).toBe(false)

  const second = window.getByTestId("file-tree-file").filter({ hasText: "no-ask.txt" })
  await second.focus()
  await window.keyboard.press("Meta+Backspace")
  await expect(second).toHaveCount(0, { timeout: 30_000 })
  await expect(window.getByRole("alertdialog")).toHaveCount(0)
  await expect.poll(() => exists(join(repoDir, "no-ask.txt"))).toBe(false)

  // Settings > Editor shows the confirmation switched off.
  await window.getByTestId("editor-settings").click()
  await window.getByTestId("editor-advanced-settings-link").click()
  await expect(window.getByTestId("settings-editor-confirm-file-delete")).toHaveAttribute(
    "data-checked",
    "false",
  )
})

test("the Show hidden files setting hides and shows dotfiles in the tree", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("panel-tab-files").click()

  const dotfile = window.getByTestId("file-tree-file").filter({ hasText: ".env.example" })
  await expect(dotfile).toBeVisible({ timeout: 30_000 })

  await window.getByTestId("editor-settings").click()
  await window.getByTestId("editor-advanced-settings-link").click()
  const toggle = window.getByTestId("settings-editor-show-hidden-files")
  await expect(toggle).toHaveAttribute("data-checked", "true")
  await toggle.click()
  await expect(toggle).toHaveAttribute("data-checked", "false", { timeout: 30_000 })
  await window.getByTestId("settings-back").click()

  await window.getByTestId("panel-tab-files").click()
  await expect(window.getByTestId("file-tree-file").filter({ hasText: "README.md" })).toBeVisible({
    timeout: 30_000,
  })
  await expect(dotfile).toHaveCount(0)

  await window.getByTestId("editor-settings").click()
  await window.getByTestId("editor-advanced-settings-link").click()
  await window.getByTestId("settings-editor-show-hidden-files").click()
  await window.getByTestId("settings-back").click()
  await window.getByTestId("panel-tab-files").click()
  await expect(dotfile).toBeVisible({ timeout: 30_000 })
})
