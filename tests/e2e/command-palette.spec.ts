import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

/**
 * Whole-app E2E for the ⌘P command palette. Launches the
 * real build with one opened project, then: ⌘P opens the palette, an empty query lists
 * entries, Esc dismisses; and typing a project name + Enter jumps to that project view
 * (proves the projects source + fuzzy filter + navigation end-to-end). Keys use the
 * platform-aware `ControlOrMeta` so the same spec passes on Linux CI.
 */
const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

let app: ElectronApplication
let dataDir: string
let repoDir: string
let addedRepoDir: string

const FUZZY_FILE = "notes/quantum-observations.md"
const FUZZY_FILE_CONTENT = "# Quantum observations\n\nDistinctive quick-open fixture.\n"

async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", dir])
  const run = (args: string[]) => execFileAsync("git", ["-C", dir, ...args])
  await run(["config", "user.email", "test@pi-lab.local"])
  await run(["config", "user.name", "PI Lab Test"])
  await writeFile(join(dir, "RESEARCH.md"), "# Fixture\n\nbody\n")
  await mkdir(join(dir, "notes"))
  await writeFile(join(dir, FUZZY_FILE), FUZZY_FILE_CONTENT)
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-palette-"))
  repoDir = join(dataDir, "repo")
  addedRepoDir = join(dataDir, "added-repo")
  await initRepo(repoDir)
  await initRepo(addedRepoDir)
  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: repoDir,
      PI_LAB_TEST_PICK_DIRECTORY: addedRepoDir,
    },
  })
})

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("⌘P opens the command palette, lists entries, and Esc dismisses", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  await window.keyboard.press("ControlOrMeta+p")
  await expect(window.getByTestId("command-palette")).toBeVisible({ timeout: 30_000 })
  // Empty query lists the static commands (navigations + view toggles, ≥ 1).
  expect(await window.getByTestId("command-palette-item").count()).toBeGreaterThan(0)

  await window.keyboard.press("Escape")
  await expect(window.getByTestId("command-palette")).toHaveCount(0)
})

test("⌘P → type a project name → Enter jumps to that project", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  // The opened project shows in the sidebar before we search for it.
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })

  await window.keyboard.press("ControlOrMeta+p")
  await expect(window.getByTestId("command-palette")).toBeVisible({ timeout: 30_000 })

  // Typing the repo name fuzzy-matches the project entry to the top.
  await window.getByTestId("command-palette-input").fill("repo")
  const top = window.getByTestId("command-palette-item").first()
  await expect(top).toBeVisible({ timeout: 30_000 })
  await expect(top).toContainText("repo")

  await window.keyboard.press("Enter")
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
})

test("Add project opens the shared chooser and enters the folder returned by the picker", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  await window.keyboard.press("ControlOrMeta+p")
  await window.getByTestId("command-palette-input").fill("add project")
  const command = window.locator('[data-command-id="add-project"]')
  await expect(command).toBeVisible({ timeout: 30_000 })
  await command.click()

  await expect(window.getByTestId("command-palette")).toHaveCount(0)
  await expect(window.getByTestId("add-project-menu")).toBeVisible()
  await expect(window.getByTestId("add-project-folder")).toBeVisible()
  await expect(window.getByTestId("add-project-clone")).toBeVisible()
  await expect(window.getByTestId("add-project-template")).toBeVisible()

  await window.getByTestId("add-project-folder").click()
  await expect(window.getByTestId("add-project-dialog")).toHaveCount(0)

  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByRole("heading", { name: "added-repo" })).toBeVisible()
})

test("New file chooses a project and path, then opens the created file in that project", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  await window.keyboard.press("ControlOrMeta+p")
  await window.getByTestId("command-palette-input").fill("new file")
  const command = window.locator('[data-command-id="new-file"]')
  await expect(command).toBeVisible({ timeout: 30_000 })
  await command.click()

  await expect(window.getByTestId("command-palette")).toHaveCount(0)
  const dialog = window.getByTestId("new-file-dialog")
  await expect(dialog).toBeVisible()
  await dialog.getByLabel("Project").selectOption({ index: 1 })
  await dialog.getByLabel("File name").fill("notes/from-dashboard.md")
  await dialog.getByRole("button", { name: "Create and open" }).click()

  await expect(dialog).toHaveCount(0)
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await expect(
    window.getByTestId("central-tab").filter({ hasText: "from-dashboard.md" }),
  ).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("editor-buffer")).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(async () => readFile(join(repoDir, "notes", "from-dashboard.md"), "utf8"))
    .toBe("")

  // The command remains global while this same project view is already mounted.
  // Navigating to the current route does not remount it, so the live handoff must
  // still open the second created file instead of leaving it only on disk.
  await window.keyboard.press("ControlOrMeta+p")
  await window.getByTestId("command-palette-input").fill("new file")
  await window.locator('[data-command-id="new-file"]').click()
  const sameProjectDialog = window.getByTestId("new-file-dialog")
  await expect(sameProjectDialog).toHaveCount(0)
  await expect(window.getByTestId("central-tab").filter({ hasText: "untitled.md" })).toBeVisible()
  await window.keyboard.press("ControlOrMeta+s")
  await expect(sameProjectDialog).toBeVisible()
  await expect(sameProjectDialog.getByLabel("Project")).toHaveValue(/.+/)
  await sameProjectDialog.getByLabel("File name").fill("notes/from-project.md")
  await sameProjectDialog.getByRole("button", { name: "Create and open" }).click()

  await expect(
    window.getByTestId("central-tab").filter({ hasText: "from-project.md" }),
  ).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(async () => readFile(join(repoDir, "notes", "from-project.md"), "utf8"))
    .toBe("")
})

test("Go to Projects returns to the home view", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })

  await window.keyboard.press("ControlOrMeta+p")
  await window.getByTestId("command-palette-input").fill("projects")
  const command = window.locator('[data-command-id="nav-dashboard"]')
  await expect(command).toHaveText(/Go to Projects/)
  await command.click()

  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })
})

test("⌘F outside a project opens the project finder and jumps to a project", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })

  // On the dashboard (not a project view), ⌘F finds a project rather than files.
  await window.keyboard.press("ControlOrMeta+f")
  await expect(window.getByTestId("quick-find")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("quick-find-input").fill("repo")
  const top = window.getByTestId("quick-find-item").first()
  await expect(top).toBeVisible({ timeout: 30_000 })
  await expect(top).toContainText("repo")

  await window.keyboard.press("Enter")
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
})

test("a recorded command-palette binding opens the palette and persists across reload", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  // Record the binding through the same Settings UI the user operates.
  await window.keyboard.press("ControlOrMeta+,")
  await expect(window.getByTestId("settings-view")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("settings-nav-shortcuts").click()
  await window.getByTestId("shortcut-command-palette-rebind").click()
  await expect(window.getByTestId("shortcut-command-palette")).toHaveText("Press keys…")
  await window.keyboard.press("ControlOrMeta+k")
  await expect(window.getByTestId("shortcut-command-palette")).toHaveText("⌘K")

  await window.getByTestId("settings-back").click()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.keyboard.press("ControlOrMeta+k")
  await expect(window.getByTestId("command-palette")).toBeVisible({ timeout: 30_000 })
  await window.keyboard.press("Escape")

  // Renderer reload is the persistence boundary for this localStorage-backed preference.
  await window.reload()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.keyboard.press("ControlOrMeta+k")
  await expect(window.getByTestId("command-palette")).toBeVisible({ timeout: 30_000 })
})

test("Settings rejects a conflicting palette chord and leaves project ⌘F fuzzy-open intact", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  await window.keyboard.press("ControlOrMeta+,")
  await expect(window.getByTestId("settings-view")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("settings-nav-shortcuts").click()
  await expect(window.getByTestId("shortcut-command-palette")).toHaveText("⌘P")
  await expect(window.getByTestId("shortcut-quick-open")).toHaveText("⌘F")

  await window.getByTestId("shortcut-command-palette-rebind").click()
  await window.keyboard.press("ControlOrMeta+f")
  const conflict = window.getByRole("alert")
  await expect(conflict).toContainText("⌘F")
  await expect(conflict).toContainText("Quick open file")
  await expect(window.getByTestId("shortcut-command-palette")).toHaveText("Press keys…")

  // Cancel the recorder: the rejected chord never replaces the prior ⌘P binding.
  await window.getByTestId("shortcut-command-palette-rebind").click()
  await expect(window.getByTestId("shortcut-command-palette")).toHaveText("⌘P")
  await expect(conflict).toHaveCount(0)

  await window.getByTestId("settings-back").click()
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })

  await window.keyboard.press("ControlOrMeta+f")
  await expect(window.getByTestId("quick-open")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("quick-open-input").fill("qntobs")
  await expect(window.getByTestId("quick-open-result").first()).toHaveAttribute(
    "data-rel-path",
    FUZZY_FILE,
  )
})

test("⌘F inside a project fuzzy-searches and opens the matched file", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })

  await window.keyboard.press("ControlOrMeta+f")
  await expect(window.getByTestId("quick-open")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("quick-open-input").fill("qntobs")
  const result = window.getByTestId("quick-open-result").first()
  await expect(result).toBeVisible({ timeout: 30_000 })
  await expect(result).toHaveAttribute("data-rel-path", FUZZY_FILE)

  await window.keyboard.press("Enter")
  await expect(window.getByTestId("quick-open")).toHaveCount(0)
  await expect(
    window.getByTestId("central-tab").filter({ hasText: "quantum-observations.md" }),
  ).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("editor-buffer")).toContainText(
    "Distinctive quick-open fixture",
    {
      timeout: 30_000,
    },
  )
})

test("Settings opened from a project palette returns to that project on Escape", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("project-view")).toBeVisible()
  await window.keyboard.press("ControlOrMeta+p")
  await window.locator('[data-command-id="nav-settings"]').click()
  await expect(window.getByTestId("settings-nav-general")).toHaveAttribute("data-active", "true")
  await window.keyboard.press("Escape")
  await expect(window.getByTestId("project-view")).toBeVisible()
})

test("palette changes individual settings directly and preserves them after reload", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })
  for (const command of [
    "settings-keep-running-after-close",
    "settings-restore-project-tabs",
    "settings-update-channel-beta",
  ]) {
    await window.keyboard.press("ControlOrMeta+p")
    await window.locator(`[data-command-id="${command}"]`).click({ timeout: 5000 })
    await expect(window.getByTestId("command-palette")).toHaveCount(0)
    await expect(window.getByTestId("dashboard")).toBeVisible()
  }
  await window.reload()
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })
  await window.keyboard.press("ControlOrMeta+,")
  await expect(window.getByTestId("settings-keep-running-after-close")).toHaveAttribute(
    "aria-checked",
    "false",
  )
  await expect(window.getByTestId("settings-restore-project-tabs")).toHaveAttribute(
    "aria-checked",
    "false",
  )
  await expect(window.getByTestId("settings-update-channel")).toHaveValue("beta")
})
