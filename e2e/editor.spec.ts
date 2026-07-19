import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

/**
 * Whole-app E2E (md/engineering/testing-and-build.md) for the built-in editor (spec: TODO "Built-in
 * editor"). Launch the real Electron build, open a temp git repo as a project via
 * the `?openProject` seam (landing directly on the rich project view), then
 * exercise the editor end-to-end:
 *   1. open a seeded text file from the right-sidebar **Files** tab (the tree now
 *      lives there; files open as tabs in the central panel),
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
 * Driven through the same seams as `projects.spec.ts`: `PI_LAB_TEST_OPEN_PROJECT`
 * + `PI_LAB_TEST_AGENT_ID` (env → renderer query params). No native dialogs.
 *
 * MUST run under Node (not Bun) — Playwright's `_electron` launcher hangs under
 * Bun (md/engineering/testing-and-build.md (build & ship)); the repo `e2e` script runs Playwright's CLI through node.
 */

const SEED_FILE = "edit-me.txt"
const SEED_CONTENT = "original line\n"
const PY_FILE = "module.py"
const PY_CONTENT = "import os\n\n\ndef main():\n    return 1\n"
const PY_RUN_MARKER = "PYTHON-RUN-E2E-OK"
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
  await run(["config", "user.email", "test@pi-lab.local"])
  await run(["config", "user.name", "PI Lab Test"])
  await writeFile(join(dir, "README.md"), "# fixture\n")
  await writeFile(join(dir, "RESEARCH.md"), "# Fixture\n\nbody\n")
  await writeFile(join(dir, SEED_FILE), SEED_CONTENT)
  await writeFile(join(dir, PY_FILE), PY_CONTENT)
  if (process.platform !== "win32") {
    const venvBin = join(dir, ".venv", "bin")
    await mkdir(venvBin, { recursive: true })
    await writeFile(
      join(venvBin, "python3"),
      `#!/bin/sh
if [ "\${1-}" = "-c" ]; then
  printf '{"executable":"%s","version":"3.13"}\\n' "$0"
  exit 0
fi
if [ "\${1-}" != "${PY_FILE}" ]; then
  printf 'unexpected Python file argument: %s\\n' "\${1-}" >&2
  exit 64
fi
printf '${PY_RUN_MARKER}\\n'
`,
      { mode: 0o755 },
    )
  }
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-editor-"))
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
      PI_LAB_TEST_AGENT_ID: "test-echo",
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

  // Land directly on the rich project view; open the Files tab (the tree now
  // lives in the right sidebar) and open the seeded text file from it.
  const projectItem = window.getByTestId("project-item")
  await expect(projectItem).toBeVisible({ timeout: 30_000 })
  await projectItem.click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })

  await window.getByTestId("panel-tab-files").click()
  const fileEntry = window.getByTestId("file-tree-file").filter({ hasText: SEED_FILE })
  await expect(fileEntry).toBeVisible({ timeout: 30_000 })
  await fileEntry.click()

  // The buffer mounts in the central panel and shows the file's content + a
  // (non-dirty) tab.
  const buffer = window.getByTestId("editor-buffer")
  await expect(buffer).toBeVisible({ timeout: 30_000 })
  await expect(buffer).toContainText("original line", { timeout: 30_000 })
  await expect(window.getByTestId("central-tab")).toBeVisible()
  await expect(window.getByTestId("central-tab-dirty")).toHaveCount(0)

  // Edit: focus the CodeMirror editable area, jump to the document end, and type
  // the marker, then ⌘S. (Clicking the wrapper isn't enough — the contenteditable
  // `.cm-content` must hold focus for keystrokes to land.)
  const content = buffer.locator(".cm-content")
  await content.click()
  // Platform-aware keys: ControlOrMeta resolves to Cmd on macOS and Ctrl
  // elsewhere. Use `End` (not ArrowDown) for doc-end — CodeMirror's
  // Cmd-ArrowDown binding is mac-only, but `Mod-End` (Cmd/Ctrl-End) is
  // cross-platform — so the same press lands on Linux CI too.
  await window.keyboard.press("ControlOrMeta+End")
  await window.keyboard.type(APPENDED)
  // The tab is now dirty.
  await expect(window.getByTestId("central-tab-dirty")).toBeVisible({ timeout: 30_000 })

  await window.keyboard.press("ControlOrMeta+s")

  // The save clears the dirty indicator…
  await expect(window.getByTestId("central-tab-dirty")).toHaveCount(0, { timeout: 30_000 })

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

  // Open the in-toolbar settings menu (the gear lives in the central panel).
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

  // Open the seeded Python file from the Files tab.
  await window.getByTestId("panel-tab-files").click()
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

test.describe("Python environment and run-file on POSIX", () => {
  test.skip(
    process.platform === "win32",
    "The deterministic fixture is a POSIX .venv interpreter shim; Windows needs a native fake python.exe.",
  )

  test("detects .venv and runs the focused Python file in a real terminal", async () => {
    const window = await app.firstWindow()

    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    const projectItem = window.getByTestId("project-item")
    await expect(projectItem).toBeVisible({ timeout: 30_000 })
    await projectItem.click()
    await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })

    await window.getByTestId("panel-tab-files").click()
    const pyEntry = window.getByTestId("file-tree-file").filter({ hasText: PY_FILE })
    await expect(pyEntry).toBeVisible({ timeout: 30_000 })
    await pyEntry.click()

    await expect(window.getByTestId("editor-buffer")).toBeVisible({ timeout: 30_000 })
    const runtime = window.getByTestId("editor-python-runtime")
    await expect(runtime).toHaveText("repo/.venv (3.13)", { timeout: 30_000 })
    await expect(runtime).toHaveAttribute(
      "title",
      join(await realpath(repoDir), ".venv", "bin", "python3"),
    )

    const runPython = window.getByTestId("central-run-python")
    await expect(runPython).toBeVisible()
    await expect(runPython).toBeEnabled()
    await window.getByTestId("editor-buffer").locator(".cm-content").click()
    await window.keyboard.press("ControlOrMeta+Enter")

    const runTab = window.getByTestId("central-tab").filter({ hasText: `Run ${PY_FILE}` })
    await expect(runTab).toBeVisible({ timeout: 30_000 })
    await expect(runTab).toHaveAttribute("data-tab-kind", "terminal")

    const terminal = window.getByTestId("terminal")
    await expect(terminal).toBeVisible({ timeout: 30_000 })
    await expect(terminal).toContainText(PY_RUN_MARKER, { timeout: 30_000 })
  })

  test("runs below the editor without creating a central terminal tab", async () => {
    const window = await app.firstWindow()
    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await window.getByTestId("project-item").click()
    await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
    await window.getByTestId("panel-tab-files").click()
    await window.getByTestId("file-tree-file").filter({ hasText: PY_FILE }).click()
    await expect(window.getByTestId("editor-buffer")).toBeVisible({ timeout: 30_000 })

    await window.getByTestId("editor-settings").click()
    await window.getByTestId("editor-settings-run-destination").selectOption("below-editor")
    await expect(window.getByTestId("editor-settings-run-destination")).toHaveValue("below-editor")
    await window.keyboard.press("Escape")

    await window.getByTestId("editor-buffer").locator(".cm-content").click()
    await window.keyboard.press("ControlOrMeta+Enter")
    const region = window.getByTestId("editor-run-terminal")
    await expect(region).toBeVisible({ timeout: 30_000 })
    await expect(region.getByTestId("terminal")).toContainText(PY_RUN_MARKER, {
      timeout: 30_000,
    })
    await expect(
      window.getByTestId("central-tab").filter({ hasText: `Run ${PY_FILE}` }),
    ).toHaveCount(0)

    await window.getByTestId("editor-run-terminal-collapse").click()
    await expect(region.getByTestId("terminal")).toHaveCount(0)
    await window.getByTestId("editor-run-terminal-collapse").click()
    await expect(region.getByTestId("terminal")).toBeVisible()
  })
})
