import { type ChildProcess, execFile } from "node:child_process"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
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
} from "@playwright/test"

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string
const RECOVERY_PREFIX = "pi-lab.projectWorkspace.v2."
const STORAGE_LIMIT = 4 * 1024 * 1024
const FILE = "draft.txt"
const ORIGINAL = "original on disk\n"
const execFileAsync = promisify(execFile)

let app: ElectronApplication
let fixtureProcess: ChildProcess | undefined
let dataDir: string
let alpha: string
let beta: string

/** The files and git workspaces are real; shutdown is driven through native Electron actions. */
async function initRepo(path: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", path])
  const run = (args: string[]) => execFileAsync("git", ["-C", path, ...args])
  await run(["config", "user.email", "test@pi-lab.local"])
  await run(["config", "user.name", "PI Lab Test"])
  await writeFile(join(path, FILE), ORIGINAL)
  // Large fixtures avoid sending large edits through synthetic typing. Both are below 1 MB.
  await writeFile(join(path, "large.txt"), `${"a".repeat(99)}\n`.repeat(9_500))
  await writeFile(join(path, "medium.txt"), `${"b".repeat(99)}\n`.repeat(800))
  await writeFile(join(path, "boundary.txt"), "x")
  await run(["add", "."])
  await run(["commit", "-m", "recovery fixture"])
}

/** Relaunch the same Chromium profile and SQLite database after an approved shutdown. */
async function launch(): Promise<Page> {
  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: alpha,
      PI_LAB_TEST_PICK_DIRECTORY: beta,
      PI_LAB_TEST_AGENT_ID: "test-echo",
    },
  })
  fixtureProcess = app.process()
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  return window
}

async function openProject(window: Page, name: string): Promise<void> {
  await window.getByTestId("project-item").filter({ hasText: name }).click()
  await expect(window.getByTestId("project-view")).toBeVisible()
}

async function openFile(window: Page, name: string): Promise<void> {
  await window.getByTestId("panel-tab-files").click()
  await window.getByTestId("file-tree-file").filter({ hasText: name }).click()
  await expect(window.getByTestId("editor-buffer")).toBeVisible()
}

async function append(window: Page, text: string): Promise<void> {
  await window.getByTestId("editor-buffer").locator(".cm-content").click()
  await window.keyboard.press("ControlOrMeta+End")
  await window.keyboard.insertText(text)
  await expect(window.getByTestId("central-tab-dirty").last()).toBeVisible()
}

/** Toggle the actual Settings control before returning to the previous route. */
async function restoreTabs(window: Page, enabled: boolean): Promise<void> {
  await window.getByTestId("nav-settings").click()
  const toggle = window.getByTestId("settings-restore-project-tabs")
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute("aria-checked")) !== String(enabled)) await toggle.click()
  await expect(toggle).toHaveAttribute("aria-checked", String(enabled))
  await window.getByTestId("settings-back").click()
}

async function requestShutdown(intent: "quit" | "close"): Promise<void> {
  await app.evaluate(({ app, BrowserWindow }, requested) => {
    if (requested === "quit") app.quit()
    else BrowserWindow.getAllWindows()[0].close()
  }, intent)
}

/** Storage reads are evidence only: no injected failure or direct recovery-state writes. */
async function recoveryValues(window: Page): Promise<string[]> {
  return window.evaluate((prefix) => {
    const values: string[] = []
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (key?.startsWith(prefix)) values.push(localStorage.getItem(key) ?? "")
    }
    return values
  }, RECOVERY_PREFIX)
}

async function recoveryBytes(window: Page): Promise<number> {
  return window.evaluate((prefix) => {
    let bytes = 0
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (key?.startsWith(prefix))
        bytes += 2 * (key.length + (localStorage.getItem(key)?.length ?? 0))
    }
    return bytes
  }, RECOVERY_PREFIX)
}

test.beforeEach(async () => {
  test.setTimeout(90_000)
  fixtureProcess = undefined
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-recovery-"))
  alpha = join(dataDir, "repo-alpha")
  beta = join(dataDir, "repo-beta")
  await initRepo(alpha)
  await initRepo(beta)
})

test.afterEach(async () => {
  if (fixtureProcess && fixtureProcess.exitCode === null && fixtureProcess.signalCode === null) {
    // Forced fixture cleanup only. Assertions above always use guarded native close/quit.
    const currentProcess = fixtureProcess
    const forceExit = setTimeout(() => currentProcess.kill("SIGKILL"), 5_000)
    await app
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
      })
      .catch(() => undefined) // Destroy may already quit Electron on platforms without a Dock.
    await app.close().catch(() => currentProcess.kill("SIGKILL"))
    clearTimeout(forceExit)
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("native quit Cancel preserves edits, conflicting Save cannot overwrite, and resolved Save reaches disk", async () => {
  const window = await launch()
  await restoreTabs(window, false)
  await openProject(window, "repo-alpha")
  await openFile(window, FILE)
  await append(window, "LOCAL-QUIT-DRAFT")

  await requestShutdown("quit")
  const dialog = window.getByRole("dialog", { name: "Unsaved changes" })
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(window.getByTestId("editor-buffer")).toContainText("LOCAL-QUIT-DRAFT")
  expect(await readFile(join(alpha, FILE), "utf8")).toBe(ORIGINAL)

  const external = "external replacement on disk\n"
  await writeFile(join(alpha, FILE), external)
  await requestShutdown("quit")
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Save affected", exact: true }).click()
  await expect(dialog.getByRole("alert")).toBeVisible()
  expect(await readFile(join(alpha, FILE), "utf8")).toBe(external)
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await window.getByRole("button", { name: "Reload from disk", exact: true }).click()
  await expect(window.getByTestId("editor-buffer")).toContainText("external replacement")
  await append(window, "SAVED-ON-QUIT")

  await requestShutdown("quit")
  await expect(dialog).toBeVisible()
  const closed = app.waitForEvent("close")
  await dialog.getByRole("button", { name: "Save affected", exact: true }).click()
  await closed
  expect(await readFile(join(alpha, FILE), "utf8")).toContain("SAVED-ON-QUIT")
})

test("native window Discard removes affected stale recovery without changing disk across relaunch", async () => {
  let window = await launch()
  await openProject(window, "repo-alpha")
  await openFile(window, FILE)
  await append(window, "PREVIOUS-PROTECTED-DRAFT")
  await expect
    .poll(async () => (await recoveryValues(window)).join("\n"))
    .toContain("PREVIOUS-PROTECTED-DRAFT")
  await restoreTabs(window, false)
  await expect(window.getByTestId("editor-buffer")).toContainText("PREVIOUS-PROTECTED-DRAFT")
  await append(window, "CURRENT-AFFECTED-DRAFT")
  await requestShutdown("close")
  const dialog = window.getByRole("dialog", { name: "Unsaved changes" })
  await expect(dialog).toBeVisible()
  const closed = window.waitForEvent("close")
  await dialog.getByRole("button", { name: "Discard affected", exact: true }).click()
  await closed
  expect(await readFile(join(alpha, FILE), "utf8")).toBe(ORIGINAL)
  await app.close()

  window = await launch()
  expect((await recoveryValues(window)).join("\n")).not.toContain("PREVIOUS-PROTECTED-DRAFT")
  expect((await recoveryValues(window)).join("\n")).not.toContain("CURRENT-AFFECTED-DRAFT")
  await restoreTabs(window, true)
  await openProject(window, "repo-alpha")
  await openFile(window, FILE)
  await expect(window.getByTestId("editor-buffer")).toContainText("original on disk")
  await expect(window.getByTestId("editor-buffer")).not.toContainText("AFFECTED-DRAFT")
})

test("native quit flushes protected active and inactive project drafts and restores both on relaunch", async () => {
  let window = await launch()
  await openProject(window, "repo-alpha")
  await openFile(window, FILE)
  await append(window, "ALPHA-INACTIVE-DRAFT")
  await window.keyboard.press("ControlOrMeta+p")
  await window.getByTestId("command-palette-input").fill("add project")
  await window.locator('[data-command-id="add-project"]').click()
  await window.getByTestId("add-project-folder").click()
  await expect(window.getByRole("dialog", { name: "Plan this project" })).toBeVisible()
  await window.getByRole("button", { name: "Maybe later" }).click()
  await expect(window.getByRole("heading", { name: "repo-beta", exact: true })).toBeVisible()
  await openFile(window, FILE)
  await append(window, "BETA-ACTIVE-DRAFT")
  const closed = app.waitForEvent("close")
  await requestShutdown("quit")
  await closed
  expect(await readFile(join(alpha, FILE), "utf8")).toBe(ORIGINAL)
  expect(await readFile(join(beta, FILE), "utf8")).toBe(ORIGINAL)

  window = await launch()
  await openProject(window, "repo-alpha")
  await expect(window.getByTestId("editor-buffer")).toContainText("ALPHA-INACTIVE-DRAFT")
  await expect(window.getByTestId("central-tab-dirty")).toBeVisible()
  await openProject(window, "repo-beta")
  await expect(window.getByTestId("editor-buffer")).toContainText("BETA-ACTIVE-DRAFT")
  await expect(window.getByTestId("central-tab-dirty")).toBeVisible()
})

test("Save affected on native quit writes unprotected active and inactive project edits", async () => {
  const window = await launch()
  await restoreTabs(window, false)
  await openProject(window, "repo-alpha")
  await openFile(window, FILE)
  await append(window, "ALPHA-UNPROTECTED-SAVE")
  await window.keyboard.press("ControlOrMeta+p")
  await window.getByTestId("command-palette-input").fill("add project")
  await window.locator('[data-command-id="add-project"]').click()
  await window.getByTestId("add-project-folder").click()
  await expect(window.getByRole("dialog", { name: "Plan this project" })).toBeVisible()
  await window.getByRole("button", { name: "Maybe later" }).click()
  await expect(window.getByRole("heading", { name: "repo-beta", exact: true })).toBeVisible()
  await openFile(window, FILE)
  await append(window, "BETA-UNPROTECTED-SAVE")
  await openProject(window, "repo-alpha")
  await expect(window.getByTestId("editor-buffer")).toContainText("ALPHA-UNPROTECTED-SAVE")
  await openProject(window, "repo-beta")
  await expect(window.getByTestId("editor-buffer")).toContainText("BETA-UNPROTECTED-SAVE")
  await requestShutdown("quit")
  const dialog = window.getByRole("dialog", { name: "Unsaved changes" })
  await expect(dialog).toBeVisible()
  const closed = app.waitForEvent("close")
  await dialog.getByRole("button", { name: "Save affected", exact: true }).click()
  await closed
  expect(await readFile(join(alpha, FILE), "utf8")).toContain("ALPHA-UNPROTECTED-SAVE")
  expect(await readFile(join(beta, FILE), "utf8")).toContain("BETA-UNPROTECTED-SAVE")
})

test("canceling untitled Save As during native quit keeps the app and draft open", async () => {
  const window = await launch()
  await restoreTabs(window, false)
  await openProject(window, "repo-alpha")
  await window.keyboard.press("ControlOrMeta+p")
  await window.getByTestId("command-palette-input").fill("new file")
  await window.locator('[data-command-id="new-file"]').click()
  await expect(window.getByTestId("central-tab")).toContainText("untitled.md")
  await append(window, "UNTITLED-SAVE-CANCELED")
  await requestShutdown("quit")
  const shutdown = window.getByRole("dialog", { name: "Unsaved changes" })
  await expect(shutdown).toBeVisible()
  await shutdown.getByRole("button", { name: "Save affected", exact: true }).click()
  const saveAs = window.getByRole("dialog", { name: "New file", exact: true })
  await expect(saveAs).toBeVisible()
  await saveAs.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(shutdown).toBeVisible()
  await expect(shutdown.getByRole("alert")).toBeVisible()
  await shutdown.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(window.getByTestId("editor-buffer")).toContainText("UNTITLED-SAVE-CANCELED")
  await requestShutdown("close")
  const closed = window.waitForEvent("close")
  await shutdown.getByRole("button", { name: "Discard affected", exact: true }).click()
  await closed
})

test("ordinary Save As moves an unchanged untitled draft to another project and later saves use that project", async () => {
  const window = await launch()
  await openProject(window, "repo-alpha")
  await window.keyboard.press("ControlOrMeta+p")
  await window.getByTestId("command-palette-input").fill("add project")
  await window.locator('[data-command-id="add-project"]').click()
  await window.getByTestId("add-project-folder").click()
  await expect(window.getByRole("dialog", { name: "Plan this project" })).toBeVisible()
  await window.getByRole("button", { name: "Maybe later" }).click()
  await expect(window.getByRole("heading", { name: "repo-beta", exact: true })).toBeVisible()
  await openProject(window, "repo-alpha")
  await window.keyboard.press("ControlOrMeta+p")
  await window.getByTestId("command-palette-input").fill("new file")
  await window.locator('[data-command-id="new-file"]').click()
  await expect(window.getByTestId("central-tab")).toContainText("untitled.md")
  await append(window, "CROSS-PROJECT-DRAFT")
  await window.keyboard.press("ControlOrMeta+s")
  const saveAs = window.getByRole("dialog", { name: "New file", exact: true })
  await expect(saveAs).toBeVisible()
  const project = saveAs.getByLabel("Project")
  const betaId = await project
    .locator("option")
    .filter({ hasText: "repo-beta" })
    .getAttribute("value")
  if (!betaId) throw new Error("Save As did not offer repo-beta")
  await project.selectOption(betaId)
  await saveAs.getByLabel("File name").fill("cross-project.md")
  await saveAs.getByRole("button", { name: "Create and open", exact: true }).click()
  await expect(saveAs).toHaveCount(0)
  await expect(window.getByRole("heading", { name: "repo-alpha", exact: true })).toBeVisible()
  await expect
    .poll(() => readFile(join(beta, "cross-project.md"), "utf8"))
    .toBe("CROSS-PROJECT-DRAFT")
  await expect(stat(join(alpha, "cross-project.md"))).rejects.toMatchObject({ code: "ENOENT" })
  await expect(window.getByTestId("central-tab").filter({ hasText: "untitled.md" })).toHaveCount(0)
  await openProject(window, "repo-beta")
  await expect(window.getByTestId("central-tab")).toContainText("cross-project.md")
  await expect(window.getByTestId("editor-buffer")).toContainText("CROSS-PROJECT-DRAFT")
  await append(window, "BETA-SUBSEQUENT-EDIT")
  await window.keyboard.press("ControlOrMeta+s")
  await expect(window.getByTestId("central-tab-dirty")).toHaveCount(0)
  expect(await readFile(join(beta, "cross-project.md"), "utf8")).toBe(
    "CROSS-PROJECT-DRAFTBETA-SUBSEQUENT-EDIT",
  )
  await expect(stat(join(alpha, "cross-project.md"))).rejects.toMatchObject({ code: "ENOENT" })
  expect(await readFile(join(alpha, FILE), "utf8")).toBe(ORIGINAL)
})

test("real recovery storage reaches 4 MiB, rejects the next character visibly, and protects native close", async () => {
  const window = await launch()
  await openProject(window, "repo-alpha")
  await openFile(window, "large.txt")
  await openFile(window, "medium.txt")
  await openFile(window, "boundary.txt")
  await expect
    .poll(async () => (await recoveryValues(window)).join("\n"))
    .toContain('"relPath":"boundary.txt"')
  const initialBytes = await recoveryBytes(window)
  expect(initialBytes).toBeLessThan(STORAGE_LIMIT)
  const remainingCharacters = (STORAGE_LIMIT - initialBytes) / 2
  expect(remainingCharacters).toBeGreaterThan(0)
  expect(remainingCharacters).toBeLessThan(30_000)
  // Plain ASCII adds exactly two serialized UTF-16 bytes per character, without JSON escaping.
  await append(window, "c".repeat(remainingCharacters))
  await expect.poll(() => recoveryBytes(window)).toBe(STORAGE_LIMIT)
  await append(window, "Z")
  await expect(window.getByTestId("recovery-warning")).toContainText("exceeds 4 MiB")
  expect(await recoveryBytes(window)).toBe(STORAGE_LIMIT)
  await requestShutdown("close")
  const dialog = window.getByRole("dialog", { name: "Unsaved changes" })
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(window.getByTestId("editor-buffer")).toContainText("Z")
  expect(await readFile(join(alpha, "boundary.txt"), "utf8")).toBe("x")
  await requestShutdown("close")
  const closed = window.waitForEvent("close")
  await dialog.getByRole("button", { name: "Discard affected", exact: true }).click()
  await closed
})

test("a real draft above 1 MB is visibly excluded, survives close Cancel, and Save affected writes it", async () => {
  const window = await launch()
  await openProject(window, "repo-alpha")
  await openFile(window, "large.txt")
  // The disk fixture is 950,000 UTF-8 bytes; this edit crosses the per-file limit by one byte.
  await append(window, "Z".repeat(50_001))
  await expect(window.getByTestId("recovery-warning")).toContainText("above 1 MB")
  await requestShutdown("close")
  const dialog = window.getByRole("dialog", { name: "Unsaved changes" })
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(window.getByTestId("editor-buffer")).toContainText("Z".repeat(50))
  expect((await readFile(join(alpha, "large.txt"), "utf8")).length).toBe(950_000)
  await requestShutdown("close")
  const closed = window.waitForEvent("close")
  await dialog.getByRole("button", { name: "Save affected", exact: true }).click()
  await closed
  const saved = await readFile(join(alpha, "large.txt"), "utf8")
  expect(Buffer.byteLength(saved, "utf8")).toBe(1_000_001)
  expect(saved.endsWith("Z".repeat(50_001))).toBe(true)
})
