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
  type Page,
  test,
} from "./fixtures/playwright"

// Uses the real Electron build: the right-sidebar tab and the left Files column are
// remembered per project (Files tab and the global left-column default when a project
// has none saved), and a dragged tab order is global and survives a relaunch.

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string
const execFileAsync = promisify(execFile)

let app: ElectronApplication | undefined
let dataDir: string

async function initRepo(path: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", path])
  const run = (args: string[]) => execFileAsync("git", ["-C", path, ...args])
  await run(["config", "user.email", "test@pi-lab.local"])
  await run(["config", "user.name", "PI Lab Test"])
  await writeFile(join(path, "RESEARCH.md"), "# Tabs fixture\n")
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

/** Launch against the shared data dir (same Chromium profile), opening `project`. */
async function launch(project: string): Promise<Page> {
  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: project,
    },
  })
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  return window
}

async function openProject(window: Page, name: string): Promise<void> {
  await window.getByTestId("project-item").filter({ hasText: name }).click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("right-sidebar")).toBeVisible({ timeout: 30_000 })
}

/** Whether some saved project workspace state has this left-column value and selected tab. */
function savedViewState(window: Page, filesPanelOpen: boolean, activeId: string): Promise<boolean> {
  return window.evaluate(
    ({ open, tab }) => {
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index)
        if (!key?.startsWith("pi-lab.projectWorkspace.v2.")) continue
        const state = JSON.parse(localStorage.getItem(key) ?? "null") as {
          filesPanelOpen?: boolean
          rightSidebarActiveId?: string | null
        } | null
        if (state?.filesPanelOpen === open && state.rightSidebarActiveId === tab) return true
      }
      return false
    },
    { open: filesPanelOpen, tab: activeId },
  )
}

function tabOrder(window: Page): Promise<string[]> {
  return window
    .getByTestId("right-sidebar")
    .getByRole("tab")
    .evaluateAll((tabs) =>
      tabs.map((tab) => (tab.getAttribute("data-testid") ?? "").replace("panel-tab-", "")),
    )
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-sidebar-tabs-"))
})

test.afterEach(async () => {
  await app?.close()
  app = undefined
  await rm(dataDir, { recursive: true, force: true })
})

test("remembers the tab and left Files column per project and keeps a global dragged tab order", async () => {
  const alpha = join(dataDir, "alpha-tabs")
  const beta = join(dataDir, "beta-tabs")
  await initRepo(alpha)
  await initRepo(beta)

  // A project with no saved state opens on Files, first in the default order, with the
  // left Files column collapsed (the global default is off).
  const first = await launch(alpha)
  await openProject(first, "alpha-tabs")
  await expect.poll(() => tabOrder(first)).toEqual(["files", "research", "todos"])
  await expect(first.getByTestId("panel-tab-files")).toHaveAttribute("aria-selected", "true")
  await expect(first.getByTestId("panel-files")).toBeVisible()
  await expect(first.getByTestId("central-files-toggle")).toHaveAttribute("aria-pressed", "false")
  await expect(first.getByTestId("central-files-panel")).toHaveCount(0)

  // Drop TODOs on the left half of Files: it lands before Files. A drag does not select.
  await first
    .getByTestId("panel-tab-todos")
    .dragTo(first.getByTestId("panel-tab-files"), { targetPosition: { x: 2, y: 5 } })
  await expect.poll(() => tabOrder(first)).toEqual(["todos", "files", "research"])
  await expect(first.getByTestId("panel-tab-files")).toHaveAttribute("aria-selected", "true")

  // Select TODOs, then toggle alpha's left column on and off: alpha now has its own
  // value (collapsed), saved with its selected tab.
  await first.getByTestId("panel-tab-todos").click()
  await first.getByTestId("central-files-toggle").click()
  await expect(first.getByTestId("central-files-panel")).toBeVisible()
  await expect.poll(() => tabOrder(first)).toEqual(["todos", "research"])
  await first.getByTestId("central-files-toggle").click()
  await expect(first.getByTestId("central-files-panel")).toHaveCount(0)
  await expect.poll(() => savedViewState(first, false, "todos")).toBe(true)
  await app?.close()

  // Relaunch into beta: the order is global and persisted; beta has no saved tab, so it
  // opens on Files, and no left-column value of its own, so it follows the global default.
  const second = await launch(beta)
  await openProject(second, "beta-tabs")
  await expect.poll(() => tabOrder(second)).toEqual(["todos", "files", "research"])
  await expect(second.getByTestId("panel-tab-files")).toHaveAttribute("aria-selected", "true")
  await expect(second.getByTestId("central-files-panel")).toHaveCount(0)

  // Turn the global default on in Settings → Project view.
  await second.getByTestId("nav-settings").click()
  await second.getByTestId("settings-nav-project-view").click()
  await second.getByTestId("settings-show-files-panel").click()
  await second.getByTestId("settings-back").click()

  // Beta follows the new default; alpha keeps its own collapsed value and reopens on TODOs.
  await openProject(second, "beta-tabs")
  await expect(second.getByTestId("central-files-panel")).toBeVisible()
  await expect.poll(() => tabOrder(second)).toEqual(["todos", "research"])
  await openProject(second, "alpha-tabs")
  await expect(second.getByTestId("central-files-panel")).toHaveCount(0)
  await expect(second.getByTestId("panel-tab-todos")).toHaveAttribute("aria-selected", "true")
  await expect.poll(() => tabOrder(second)).toEqual(["todos", "files", "research"])
})
