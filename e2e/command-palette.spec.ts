import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

/**
 * Whole-app E2E for the ⌘P command palette (TODO "Command palette on ⌘P"). Launches the
 * real build with one opened project, then: ⌘P opens the palette, an empty query lists
 * entries, Esc dismisses; and typing a project name + Enter jumps to that project view
 * (proves the projects source + fuzzy filter + navigation end-to-end). Keys use the
 * platform-aware `ControlOrMeta` so the same spec passes on Linux CI.
 */
const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

let app: ElectronApplication
let dataDir: string
let repoDir: string

async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", dir])
  const run = (args: string[]) => execFileAsync("git", ["-C", dir, ...args])
  await run(["config", "user.email", "test@skipper.local"])
  await run(["config", "user.name", "Skipper Test"])
  await writeFile(join(dir, "RESEARCH.md"), "# Fixture\n\nbody\n")
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "skipper-e2e-palette-"))
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
