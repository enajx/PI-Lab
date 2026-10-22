import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

let app: ElectronApplication
let dataDir: string
let folderDir: string

async function createPlainFolder(dir: string): Promise<void> {
  await mkdir(join(dir, "data"), { recursive: true })
  await writeFile(join(dir, "README.md"), "# Plain folder\n\nFiles still work.\n")
  await writeFile(join(dir, "TODO.md"), "# TODO\n\n- [ ] Folder task\n")
  await writeFile(join(dir, "data", "metrics.csv"), "epoch,label\n0,start\n1,end\n")
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-non-git-"))
  folderDir = join(dataDir, "plain-folder")
  await createPlainFolder(folderDir)

  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: folderDir,
      PI_LAB_TEST_AGENT_ID: "test-echo",
    },
  })
})

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("plain folders work and Git features unlock after Initialize Git", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  const projectItem = window.getByTestId("project-item")
  await expect(projectItem).toContainText("plain-folder", { timeout: 30_000 })
  await projectItem.click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })

  const notice = window.getByTestId("non-git-project-notice")
  await expect(notice).toContainText("This project is not git tracked.")
  await expect(window.getByTestId("project-view-summary")).toBeDisabled()
  await expect(window.getByTestId("project-view-fetch-experiments")).toBeDisabled()

  await window.getByTestId("right-sidebar-settings").click()
  await expect(window.getByTestId("right-sidebar-toggle-changes")).toBeDisabled()
  await expect(window.getByTestId("right-sidebar-toggle-changes")).toHaveAttribute(
    "data-feature-help",
    /Initialize Git/,
  )
  await window.keyboard.press("Escape")

  await window.getByTestId("panel-tab-files").click()
  await window.getByTestId("file-tree-file").filter({ hasText: "README.md" }).click()
  await expect(window.getByTestId("editor-buffer")).toContainText("Files still work")

  await window.getByTestId("central-new-terminal").click()
  await expect(window.getByTestId("terminal")).toBeVisible({ timeout: 30_000 })

  await window.getByTestId("central-add-menu").click()
  await window.getByTestId("central-add-agent").click()
  const newSession = window.getByTestId("new-agent-dialog")
  await expect(newSession).toContainText(
    "Start one CLI coding agent in this folder. Initialize Git to use worktrees or concurrent agents.",
  )
  await expect(newSession.getByLabel("Worktree")).toBeDisabled()
  await expect(newSession.getByLabel("Test Echo")).toBeChecked()
  await newSession.getByRole("button", { name: "Start agent" }).click()
  await expect(window.locator('[data-testid="terminal"]:visible')).toContainText("AGENT-UI-OK", {
    timeout: 30_000,
  })

  await window.locator('[data-testid="science-nav-item"][data-science-tab="tasks"]').click()
  await expect(window.getByTestId("science-tasks")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByText("Folder task")).toBeVisible()

  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  await expect(window.getByTestId("science-analysis")).toBeVisible({ timeout: 30_000 })
  await expect(
    window.locator('[data-testid="analysis-file"][data-rel-path="data/metrics.csv"]'),
  ).toBeVisible({ timeout: 30_000 })

  await projectItem.click()
  await window.getByRole("button", { name: "Initialize Git" }).click()
  await expect
    .poll(async () =>
      access(join(folderDir, ".git")).then(
        () => true,
        () => false,
      ),
    )
    .toBe(true)
  await expect(notice).toBeHidden({ timeout: 30_000 })
  await expect(window.getByTestId("project-view-summary")).toBeEnabled()

  await window.getByTestId("right-sidebar-settings").click()
  await expect(window.getByTestId("right-sidebar-toggle-changes")).toBeEnabled()
  await window.keyboard.press("Escape")

  await window.getByTestId("central-add-menu").click()
  await window.getByTestId("central-add-agent").click()
  await expect(window.getByTestId("new-agent-dialog").getByLabel("Worktree")).toBeEnabled()
})
