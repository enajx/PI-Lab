import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

/**
 * Whole-app E2E (AGENTS.md §14) for the built-in editor (spec: TODO "Built-in
 * editor"). Launch the real Electron build, open a temp git repo as a project via
 * the `?openProject` seam, start a session, then exercise the editor end-to-end:
 *   1. open a seeded text file from the file tree,
 *   2. edit it and ⌘S,
 *   3. assert the save reached disk (the file on disk holds the new content) and
 *      the editor reflects it (clean buffer, no dirty dot),
 *   4. the editor-settings menu opens and toggles a preference.
 *
 * The Python-diagnostics path depends on `uv`/`ty`/`ruff` being installed, which
 * the CI host may not have — so we only assert the *graceful* shape (the editor
 * opens a `.py` file and the status bar renders without crashing), never that a
 * specific tool ran.
 *
 * Driven through the same seams as `projects.spec.ts`: `SKIPPER_TEST_OPEN_PROJECT`
 * + `SKIPPER_TEST_AGENT_ID` (env → renderer query params). No native dialogs.
 *
 * MUST run under Node (not Bun) — Playwright's `_electron` launcher hangs under
 * Bun (AGENTS.md §13); the repo `e2e` script runs Playwright's CLI through node.
 */

const SEED_FILE = "edit-me.txt"
const SEED_CONTENT = "original line\n"
const PY_FILE = "module.py"
const PY_CONTENT = "import os\n\n\ndef main():\n    return 1\n"
const APPENDED = "APPENDED-BY-E2E"

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "apps", "desktop")
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
  await run(["config", "user.email", "test@skipper.local"])
  await run(["config", "user.name", "Skipper Test"])
  await writeFile(join(dir, "README.md"), "# fixture\n")
  await writeFile(join(dir, "RESEARCH.md"), "# Fixture\n\nbody\n")
  await writeFile(join(dir, SEED_FILE), SEED_CONTENT)
  await writeFile(join(dir, PY_FILE), PY_CONTENT)
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "skipper-e2e-editor-"))
  repoDir = join(dataDir, "repo")
  await initRepo(repoDir)

  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      SKIPPER_TEST_MODE: "1",
      SKIPPER_DATA_DIR: dataDir,
      SKIPPER_SOCKET_PATH: join(dataDir, "daemon.sock"),
      SKIPPER_TEST_OPEN_PROJECT: repoDir,
      SKIPPER_TEST_AGENT_ID: "test-echo",
    },
  })
})

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("open a file, edit, ⌘S, and the save reaches disk", async () => {
  const window = await app.firstWindow()

  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  // Open the project and start a session (the editor lives in the session view).
  const projectItem = window.getByTestId("project-item")
  await expect(projectItem).toBeVisible({ timeout: 30_000 })
  await projectItem.click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("open-agent").click()
  await expect(window.getByTestId("session-view")).toBeVisible({ timeout: 30_000 })

  // The editor and its file tree render.
  await expect(window.getByTestId("editor")).toBeVisible()
  await expect(window.getByTestId("file-tree")).toBeVisible()

  // Open the seeded text file from the tree.
  const fileEntry = window.getByTestId("file-tree-file").filter({ hasText: SEED_FILE })
  await expect(fileEntry).toBeVisible({ timeout: 30_000 })
  await fileEntry.click()

  // The buffer mounts and shows the file's content + a (non-dirty) tab.
  const buffer = window.getByTestId("editor-buffer")
  await expect(buffer).toBeVisible({ timeout: 30_000 })
  await expect(buffer).toContainText("original line", { timeout: 30_000 })
  await expect(window.getByTestId("editor-tab")).toBeVisible()
  await expect(window.getByTestId("editor-dirty")).toHaveCount(0)

  // Edit: focus the CodeMirror editable area, jump to the document end, and type
  // the marker, then ⌘S. (Clicking the wrapper isn't enough — the contenteditable
  // `.cm-content` must hold focus for keystrokes to land.)
  const content = buffer.locator(".cm-content")
  await content.click()
  await window.keyboard.press("Meta+ArrowDown")
  await window.keyboard.type(APPENDED)
  // The tab is now dirty.
  await expect(window.getByTestId("editor-dirty")).toBeVisible({ timeout: 30_000 })

  await window.keyboard.press("Meta+s")

  // The save clears the dirty indicator…
  await expect(window.getByTestId("editor-dirty")).toHaveCount(0, { timeout: 30_000 })

  // …and the file on disk holds the new content (proves files.write end-to-end).
  await expect
    .poll(async () => readFile(join(repoDir, SEED_FILE), "utf8"), { timeout: 30_000 })
    .toContain(APPENDED)

  // The editor still shows the edited content (buffer reflects the save).
  await expect(buffer).toContainText(APPENDED)
})

test("the editor settings menu opens and toggles a preference", async () => {
  const window = await app.firstWindow()

  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const projectItem = window.getByTestId("project-item")
  await expect(projectItem).toBeVisible({ timeout: 30_000 })
  await projectItem.click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("open-agent").click()
  await expect(window.getByTestId("session-view")).toBeVisible({ timeout: 30_000 })

  // Open the in-toolbar settings menu.
  await expect(window.getByTestId("editor-settings")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("editor-settings").click()
  await expect(window.getByTestId("editor-settings-menu")).toBeVisible()

  // Vim is off by default; toggling it flips the checked state (persisted via
  // settings.updateEditor + re-read reactively).
  const vimToggle = window.getByTestId("editor-settings-vim")
  await expect(vimToggle).toHaveAttribute("data-checked", "false")
  await vimToggle.click()
  await expect(vimToggle).toHaveAttribute("data-checked", "true", { timeout: 30_000 })
})

test("opening a Python file renders the status bar without crashing", async () => {
  const window = await app.firstWindow()

  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const projectItem = window.getByTestId("project-item")
  await expect(projectItem).toBeVisible({ timeout: 30_000 })
  await projectItem.click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("open-agent").click()
  await expect(window.getByTestId("session-view")).toBeVisible({ timeout: 30_000 })

  // Open the seeded Python file.
  const pyEntry = window.getByTestId("file-tree-file").filter({ hasText: PY_FILE })
  await expect(pyEntry).toBeVisible({ timeout: 30_000 })
  await pyEntry.click()

  await expect(window.getByTestId("editor-buffer")).toBeVisible({ timeout: 30_000 })
  // The status bar is present and names the active Python file. Whether a real
  // check ran depends on uv/ty/ruff being installed; either the diagnostics
  // summary or the "tools unavailable" hint is acceptable — we only assert the
  // editor did not crash and the bar reflects the file.
  const statusBar = window.getByTestId("editor-status-bar")
  await expect(statusBar).toBeVisible()
  await expect(statusBar).toContainText(PY_FILE)
})
