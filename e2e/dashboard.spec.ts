import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

/**
 * Whole-app E2E (md/engineering/testing-and-build.md, P7b): launch the real Electron build, boot to
 * `app-ready`, and prove the project-cards Dashboard is wired end-to-end:
 *
 *   1. the `?openProject` seam opens a temp repo on load (via the sidebar),
 *   2. the dashboard (the shell home) shows a project card carrying that
 *      project's name, with a status badge, and
 *   3. direct per-card resizing is available without the old scalar slider.
 *
 * Driven by the test seam in `mainWindow.ts` (env → renderer query param):
 * `PI_LAB_TEST_OPEN_PROJECT`. No native dialog, no agent launch needed here.
 *
 * MUST run under Node (not Bun) — Playwright's `_electron` launcher hangs under
 * Bun (md/engineering/testing-and-build.md (build & ship)).
 */

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

let app: ElectronApplication
let dataDir: string
let repoDir: string

/** Initialize a repo with one commit on `main`, deterministic identity. */
async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", dir])
  const run = (args: string[]) => execFileAsync("git", ["-C", dir, ...args])
  await run(["config", "user.email", "test@pi-lab.local"])
  await run(["config", "user.name", "PI Lab Test"])
  await writeFile(join(dir, "README.md"), "# fixture\n")
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
      // Open the temp repo as a project on load (via the renderer query seam).
      PI_LAB_TEST_OPEN_PROJECT: repoDir,
    },
  })
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-dash-"))
  repoDir = join(dataDir, "repo")
  await initRepo(repoDir)
  await launchApp()
})

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("dashboard shows a directly resizable project card", async () => {
  const window = await app.firstWindow()

  // Boot gate.
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  // The home surface is the dashboard.
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })

  // The `?openProject` seam opens the repo; the dashboard then shows a card for
  // it carrying its name (the repo folder is "repo").
  const card = window.getByTestId("project-card")
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).toContainText("repo")

  // It carries a status badge and starts at the default shared scale, with a
  // keyboard-accessible, visually quiet corner handle rather than a toolbar slider.
  await expect(window.getByTestId("project-card-status")).toBeVisible()
  await expect(window.getByTestId("card-size-slider")).toHaveCount(0)
  const grid = window.getByTestId("dashboard-grid")
  const item = window.getByTestId("project-card-grid-item")
  const resizeHandle = window.getByTestId("card-resize-handle")
  await expect(grid).toHaveAttribute("data-card-grid-base-column", "200")
  await expect(grid).toHaveAttribute("data-card-grid-scale", "1")
  await expect(item).toHaveAttribute("data-card-span", "1x1")
  await resizeHandle.focus()
  await window.keyboard.press("ArrowRight")
  await expect(grid).toHaveAttribute("data-card-grid-scale", "1.05")
  await expect(item).toHaveAttribute("data-card-span", "1x1")

  // The shared scale keeps the grid within a narrow viewport without horizontal overflow.
  await window.setViewportSize({ width: 520, height: 720 })
  expect(await grid.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  )

  // This diagnostic animation must genuinely move in the running Electron app,
  // even on the development Mac where the OS Reduce Motion preference is enabled.
  await window.bringToFront()
  const gradientLayer = window.getByTestId("project-card-gradient-layer").first()
  await expect(gradientLayer).toBeVisible()
  const motion = await gradientLayer.evaluate(async (element) => {
    const beforeStyle = getComputedStyle(element)
    const before = beforeStyle.transform
    const animationName = beforeStyle.animationName
    const playState = beforeStyle.animationPlayState
    await new Promise((resolve) => setTimeout(resolve, 350))
    const after = getComputedStyle(element).transform
    return { before, after, animationName, playState }
  })
  expect(motion.animationName).toMatch(/^pi-lab-gradient-(meander|turn|breathe|weave|orbit|rock)$/)
  expect(motion.playState).toBe("running")
  expect(motion.after).not.toBe(motion.before)
})

test("Tab toggles between the Dashboard and the last project outside raw-key focus", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const card = window.getByTestId("project-card")
  await expect(card).toBeVisible({ timeout: 30_000 })

  await card.click()
  await expect(window.getByTestId("project-view")).toBeVisible()
  await window.evaluate(() => {
    document.body.tabIndex = -1
    document.body.focus()
  })
  await window.keyboard.press("Tab")
  await expect(window.getByTestId("dashboard")).toBeVisible()
  await window.keyboard.press("Tab")
  await expect(window.getByTestId("project-view")).toBeVisible()

  await window.evaluate(() => {
    const input = document.createElement("input")
    document.body.append(input)
    input.focus()
  })
  await window.keyboard.press("Tab")
  await expect(window.getByTestId("project-view")).toBeVisible()
})

test("Dashboard navigation keeps the project's open workspace tabs", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-card").click()
  await expect(window.getByTestId("project-view")).toBeVisible()

  await window.getByTestId("panel-tab-files").click()
  await window.getByTestId("file-tree-file").click()
  await expect(window.getByTestId("central-tab")).toContainText("README.md")

  await window.evaluate(() => {
    document.body.tabIndex = -1
    document.body.focus()
  })
  await window.keyboard.press("Tab")
  await expect(window.getByTestId("dashboard")).toBeVisible()
  await window.keyboard.press("Tab")
  await expect(window.getByTestId("project-view")).toBeVisible()
  await expect(window.getByTestId("central-tab")).toContainText("README.md")
})

test("relaunching PI Lab restores the project's open workspace tabs", async () => {
  let window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-card").click()
  await window.getByTestId("panel-tab-files").click()
  await window.getByTestId("file-tree-file").click()
  await expect(window.getByTestId("central-tab")).toContainText("README.md")

  await app.close()
  await launchApp()
  window = await app.firstWindow()
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-card").click()
  await expect(window.getByTestId("project-view")).toBeVisible()
  await expect(window.getByTestId("central-tab")).toContainText("README.md")
})

test("leaving Settings restores the view that opened it", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-card").click()
  await expect(window.getByTestId("project-view")).toBeVisible()

  await window.getByTestId("nav-settings").click()
  await expect(window.getByTestId("settings-view")).toBeVisible()
  await window.getByTestId("settings-back").click()
  await expect(window.getByTestId("project-view")).toBeVisible()
})
