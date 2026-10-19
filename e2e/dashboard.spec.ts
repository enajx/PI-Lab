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
  type Locator,
  test,
} from "@playwright/test"
import { DaemonClient } from "../packages/pty-daemon/src/index"

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
      PI_LAB_TEST_AGENT_ID: "test-echo",
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

test("title bar agent status shows installed agents and current sessions", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const control = window.getByTestId("agent-status-control")
  await expect(control).toBeVisible()
  const agentBounds = await control.boundingBox()
  const caffeineBounds = await window.getByTestId("caffeine-control").boundingBox()
  expect(
    agentBounds && caffeineBounds && agentBounds.x + agentBounds.width <= caffeineBounds.x,
  ).toBe(true)
  await control.click()
  const panel = window.getByRole("dialog", { name: "Agent status" })
  await expect(panel).toBeVisible()
  await expect(panel).toContainText("Claude Code")
  await expect(panel).toContainText("Codex")
  await expect(panel).toContainText("Current sessions")
  await expect(panel).toContainText("No current sessions.")
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
  const image = card.getByTestId("project-card-image")

  // Hovering either the card body or its lower controls brightens the complete
  // card, rather than leaving the action row visually detached.
  await card.hover()
  const actions = card.getByTestId("project-card-actions")
  const filterOf = (locator: Locator) => () =>
    locator.evaluate((element) => getComputedStyle(element).filter)
  await expect.poll(filterOf(image)).not.toBe("none")
  await expect.poll(filterOf(actions)).not.toBe("none")
  await actions.hover()
  await expect.poll(filterOf(actions)).not.toBe("none")

  // A card's context menu is available from its body, not only its artwork.
  await card.getByTestId("project-card-body").click({ button: "right", position: { x: 24, y: 24 } })
  const menu = window.getByTestId("project-card-menu")
  await expect(menu).toBeVisible()
  await menu.getByTestId("project-card-menu-edit").click()
  const editDialog = window.getByTestId("edit-project-dialog")
  await editDialog.getByTestId("edit-project-emoji-add").click()
  const emojiPicker = window.getByTestId("edit-project-emoji-picker")
  await expect(emojiPicker).toBeVisible()
  await emojiPicker.locator('[data-emoji="🦾"]').click()
  await expect(editDialog.locator('[data-emoji="🦾"]')).toHaveAttribute("data-active", "true")
  await editDialog.getByTestId("edit-project-save").click()
  await expect(editDialog).toHaveCount(0)

  // The card hover treatment must not create a containing block for the fixed
  // context menu: it appears immediately at the pointer, not offset by the card.
  const imageBox = await image.boundingBox()
  if (!imageBox) throw new Error("Expected a measurable project-card thumbnail")
  await image.click({ button: "right", position: { x: 24, y: 24 } })
  await expect(menu).toBeVisible()
  const menuBox = await menu.boundingBox()
  if (!menuBox) throw new Error("Expected a measurable project-card menu")
  expect(menuBox.x).toBeCloseTo(imageBox.x + 24, 0)
  expect(menuBox.y).toBeCloseTo(imageBox.y + 24, 0)
  await menu.getByTestId("project-card-menu-thumbnail").click()
  const artworkDialog = window.getByTestId("project-card-artwork-dialog")
  await expect(artworkDialog).toBeVisible()
  await expect(artworkDialog.getByTestId("project-card-artwork-file")).toBeVisible()
  await expect(artworkDialog.getByTestId("project-card-artwork-gradient")).toBeVisible()
  await expect(artworkDialog.getByTestId("project-card-artwork-digital-rain")).toBeVisible()
  await artworkDialog.getByTestId("project-card-artwork-digital-rain").click()
  await expect(artworkDialog).toHaveCount(0)
  const digitalRain = card.getByTestId("project-card-digital-rain")
  await expect(digitalRain).toBeVisible()
  await expect(digitalRain).toHaveAttribute("data-animating", "false")
  const firstRainFrame = await digitalRain.evaluate((element) =>
    (element as HTMLCanvasElement).toDataURL(),
  )
  await window.waitForTimeout(700)
  expect(await digitalRain.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).toBe(
    firstRainFrame,
  )

  // It carries a status badge and starts at the default shared scale, with a
  // keyboard-accessible, visually quiet corner handle rather than a toolbar slider.
  await expect(window.getByTestId("project-card-status")).toBeVisible()
  await expect(window.getByTestId("card-size-slider")).toHaveCount(0)
  const grid = window.getByTestId("dashboard-grid")
  const item = window.getByTestId("project-card-grid-item")
  const resizeHandle = window.getByTestId("card-resize-handle")
  await expect(grid).toHaveAttribute("data-card-grid-base-column", "220")
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

  // The gradient layer is a baked, transparent noisy-gradient raster (not a live
  // SVG filter) with a drift animation attached. Drift is activity-gated: an idle
  // seeded project sits paused (a live "working" cue), so we assert the wiring —
  // baked data-URI background + a valid drift animation-name — rather than motion.
  await image.click({ button: "right", position: { x: 24, y: 24 } })
  await menu.getByTestId("project-card-menu-thumbnail").click()
  await window.getByTestId("project-card-artwork-gradient").click()
  await window.bringToFront()
  const gradientLayer = window.getByTestId("project-card-gradient-layer").first()
  await expect(gradientLayer).toBeVisible()
  const artwork = await gradientLayer.evaluate((element) => {
    const style = getComputedStyle(element)
    return { backgroundImage: style.backgroundImage, animationName: style.animationName }
  })
  expect(artwork.backgroundImage).toContain("data:image/svg+xml")
  expect(artwork.animationName).toMatch(/^pi-lab-gradient-(meander|turn|breathe|weave|orbit|rock)$/)
})

test("Project summary stays viewport-sized when opened from a hovered card", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })

  const card = window.getByTestId("project-card")
  const summary = card.getByTestId("project-card-summary")
  await expect(summary).toBeVisible({ timeout: 30_000 })

  await summary.hover()
  await summary.click()

  const backdrop = window.getByTestId("workflow-result-backdrop")
  await expect(backdrop).toBeVisible()
  const viewport = await window.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))
  const samples = await backdrop.evaluate(
    (element) =>
      new Promise<
        Array<{
          x: number
          y: number
          width: number
          height: number
          display: string
          visibility: string
        }>
      >((resolve) => {
        const frames: Array<{
          x: number
          y: number
          width: number
          height: number
          display: string
          visibility: string
        }> = []
        const sample = () => {
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          frames.push({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            display: style.display,
            visibility: style.visibility,
          })
          if (frames.length === 24) resolve(frames)
          else requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      }),
  )

  expect(samples).toHaveLength(24)
  for (const sample of samples) {
    expect(sample.display).not.toBe("none")
    expect(sample.visibility).toBe("visible")
    expect(sample.x).toBeCloseTo(0, 0)
    expect(sample.y).toBeCloseTo(0, 0)
    expect(sample.width).toBeCloseTo(viewport.width, 0)
    expect(sample.height).toBeCloseTo(viewport.height, 0)
  }
  await expect(window.getByTestId("workflow-result-dialog")).toBeVisible()
})

test("Digital Rain visibly moves while this project's agent is working", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  // The activity cue must still move when the OS requests reduced motion; this
  // compact 10–20 FPS canvas is the working-state signal, not decorative motion.
  await window.emulateMedia({ reducedMotion: "reduce" })
  const card = window.getByTestId("project-card")
  const image = card.getByTestId("project-card-image")

  await image.click({ button: "right", position: { x: 24, y: 24 } })
  await window.getByTestId("project-card-menu-thumbnail").click()
  await window.getByTestId("project-card-artwork-digital-rain").click()
  const digitalRain = card.getByTestId("project-card-digital-rain")
  await expect(digitalRain).toBeVisible()
  const rainHover = card.getByTestId("project-card-digital-rain-hover")
  await card.hover()
  expect(await rainHover.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
    "rgba(0, 0, 0, 0)",
  )

  await card.click()
  await window.getByTestId("central-new-agent").click()
  const chooser = window.getByTestId("new-agent-dialog")
  await chooser.locator("label", { hasText: "Test Activity" }).click()
  await expect(chooser.getByLabel("Test Activity")).toBeChecked()
  await chooser.getByRole("button", { name: "Start agent" }).click()
  await expect(window.getByTestId("terminal")).toContainText("AGENT-ACTIVE", { timeout: 30_000 })

  await window.getByTestId("nav-dashboard").click()
  await expect(card.getByTestId("project-card-status")).toContainText("Working", {
    timeout: 30_000,
  })
  await expect(digitalRain).toHaveAttribute("data-animating", "true")
  const firstRainFrame = await digitalRain.evaluate((element) =>
    (element as HTMLCanvasElement).toDataURL(),
  )
  await window.waitForTimeout(700)
  expect(
    await digitalRain.evaluate((element) => (element as HTMLCanvasElement).toDataURL()),
  ).not.toBe(firstRainFrame)
})

test("the final New project card opens the shared chooser and remains when the Dashboard is empty", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-card")).toBeVisible({ timeout: 30_000 })

  const grid = window.getByTestId("dashboard-grid")
  const newProjectCard = window.getByTestId("new-project-card")
  const trigger = window.getByRole("button", { name: "New project" })
  await expect(newProjectCard).toBeVisible()
  expect(
    await grid.evaluate((element) => element.lastElementChild?.getAttribute("data-testid")),
  ).toBe("new-project-card")
  await expect(newProjectCard).not.toHaveAttribute("data-card-grid-item", /.+/)
  await expect(newProjectCard.getByTestId("card-resize-handle")).toHaveCount(0)
  await expect(window.getByTestId("card-resize-handle")).toHaveCount(1)

  await trigger.focus()
  await window.keyboard.press("Enter")
  await expect(window.getByTestId("add-project-menu")).toBeVisible()
  await expect(window.getByTestId("add-project-folder")).toBeVisible()
  await expect(window.getByTestId("add-project-clone")).toBeVisible()
  await expect(window.getByTestId("add-project-template")).toBeVisible()
  await window.keyboard.press("Escape")
  await expect(window.getByTestId("add-project-menu")).toHaveCount(0)

  // Remove the fixture through the real public UI. The Dashboard reaches its
  // actual zero-project state without opening a native picker, and the entry
  // card remains the grid's final (and only) cell.
  await window.getByTestId("project-item").click({ button: "right" })
  await window.getByTestId("project-remove").click()
  await expect(window.getByTestId("project-card")).toHaveCount(0)
  await expect(window.getByTestId("dashboard-empty")).toHaveText("No projects yet.")
  await expect(newProjectCard).toBeVisible()
  expect(
    await grid.evaluate((element) => element.lastElementChild?.getAttribute("data-testid")),
  ).toBe("new-project-card")
})

test("a sparse Dashboard keeps its project card at the bounded grid width and left edge", async () => {
  const window = await app.firstWindow()
  await window.setViewportSize({ width: 1200, height: 800 })
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  const grid = window.getByTestId("dashboard-grid")
  const projectItem = window.getByTestId("project-card-grid-item")
  await expect(projectItem).toBeVisible({ timeout: 30_000 })
  await expect(grid).toHaveCSS("justify-content", "start")
  expect(await grid.evaluate((element) => element.style.gridTemplateColumns)).toBe(
    "repeat(auto-fill, minmax(min(100%, 220px), 220px))",
  )

  const [gridBox, projectBox] = await Promise.all([grid.boundingBox(), projectItem.boundingBox()])
  if (!gridBox || !projectBox) throw new Error("Expected measurable Dashboard grid and project")
  expect(projectBox.width).toBeCloseTo(220, 0)
  expect(projectBox.x).toBeCloseTo(gridBox.x, 0)
})

test("a hidden project disappears everywhere, can be revealed and restored, and stays restored", async () => {
  let window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-card")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible()

  // Hiding an already-open project removes its navigation row but does not tear
  // down the current workspace; it stays usable until the user navigates away.
  await window.getByTestId("project-card").click()
  await expect(window.getByTestId("project-view")).toBeVisible()
  await window.getByTestId("project-item").click({ button: "right" })
  await window.getByTestId("project-hide").click()
  await expect(window.getByTestId("project-item")).toHaveCount(0)
  await expect(window.getByTestId("project-view")).toBeVisible()
  await window.getByTestId("panel-tab-files").click()
  await window.getByTestId("file-tree-file").click()
  await expect(window.getByTestId("central-tab")).toContainText("README.md")
  await window.getByTestId("nav-dashboard").click()

  await expect(window.getByTestId("project-card")).toHaveCount(0)
  await expect(window.getByTestId("project-item")).toHaveCount(0)
  await expect(window.getByTestId("dashboard-show-hidden-projects")).toHaveText("Show hidden (1)")
  await expect(window.getByTestId("sidebar-show-hidden-projects")).toHaveText("Show hidden (1)")

  // Both affordances consume one shared state: toggling either surface updates
  // the Dashboard and sidebar together.
  await window.getByTestId("sidebar-show-hidden-projects").click()
  let hiddenCard = window.locator('[data-testid="project-card"][data-hidden="true"]')
  await expect(hiddenCard).toBeVisible()
  await expect(hiddenCard).toHaveAttribute("data-hidden", "true")
  await expect(window.locator('[data-testid="project-item"][data-hidden="true"]')).toBeVisible()

  await window.getByTestId("dashboard-show-hidden-projects").click()
  await expect(window.getByTestId("project-card")).toHaveCount(0)
  await expect(window.getByTestId("project-item")).toHaveCount(0)

  await window.getByTestId("sidebar-show-hidden-projects").click()
  hiddenCard = window.locator('[data-testid="project-card"][data-hidden="true"]')
  await expect(hiddenCard).toBeVisible()
  await expect(window.locator('[data-testid="project-item"][data-hidden="true"]')).toBeVisible()

  await hiddenCard.getByTestId("project-card-image").click({ button: "right" })
  await window.getByTestId("project-card-menu-restore").click()
  await expect(window.getByTestId("project-card")).toBeVisible()
  await expect(window.getByTestId("project-item")).toBeVisible()
  await expect(window.getByTestId("dashboard-show-hidden-projects")).toHaveCount(0)

  await window.reload()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-card")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible()

  await app.close()
  await launchApp()
  window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-card")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible()
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
  await window.getByTestId("central-new-terminal").click()
  const terminal = window.getByTestId("terminal")
  await expect(terminal).toHaveAttribute("data-session-id", /.+/)
  const liveSessionId = await terminal.getAttribute("data-session-id")

  await window.evaluate(() => {
    document.body.tabIndex = -1
    document.body.focus()
  })
  await window.keyboard.press("Tab")
  await expect(window.getByTestId("dashboard")).toBeVisible()
  await window.keyboard.press("Tab")
  await expect(window.getByTestId("project-view")).toBeVisible()
  await expect(window.getByTestId("central-tab").filter({ hasText: "README.md" })).toBeVisible()
  await expect(window.getByTestId("terminal")).toHaveAttribute(
    "data-session-id",
    liveSessionId ?? "",
  )
})

test("relaunching PI Lab restores files and recreates terminal and agent tabs", async () => {
  let window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-card").click()
  await window.getByTestId("panel-tab-files").click()
  await window.getByTestId("file-tree-file").click()
  await expect(window.getByTestId("central-tab")).toContainText("README.md")
  await window.getByTestId("central-new-terminal").click()
  const originalTerminalId = await window.getByTestId("terminal").getAttribute("data-session-id")
  await window.getByTestId("central-new-agent").click()
  const chooser = window.getByTestId("new-agent-dialog")
  await expect(chooser.getByLabel("Test Echo")).toBeChecked()
  await chooser.getByRole("button", { name: "Start agent" }).click()
  await expect(window.getByTestId("terminal").filter({ hasText: "AGENT-UI-OK" })).toBeVisible({
    timeout: 30_000,
  })
  const originalAgentId = await window
    .getByTestId("terminal")
    .filter({ hasText: "AGENT-UI-OK" })
    .getAttribute("data-session-id")

  await app.close()
  await launchApp()
  window = await app.firstWindow()
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-card").click()
  await expect(window.getByTestId("project-view")).toBeVisible()
  await expect(window.getByTestId("central-tab").filter({ hasText: "README.md" })).toBeVisible()
  await expect(window.getByTestId("central-tab")).toHaveCount(3)
  await expect(window.getByTestId("terminal").filter({ hasText: "AGENT-UI-OK" })).toBeVisible({
    timeout: 30_000,
  })
  const restoredIds = await window
    .getByTestId("terminal")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-session-id")))
  expect(restoredIds).not.toContain(originalTerminalId)
  expect(restoredIds).not.toContain(originalAgentId)
})

test("turning restoration off leaves project tabs closed after relaunch", async () => {
  let window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-card").click()
  await window.getByTestId("panel-tab-files").click()
  await window.getByTestId("file-tree-file").click()
  await expect(window.getByTestId("central-tab")).toContainText("README.md")

  await window.getByTestId("nav-settings").click()
  const restoreToggle = window.getByTestId("settings-restore-project-tabs")
  await expect(restoreToggle).toHaveAttribute("aria-checked", "true")
  await restoreToggle.click()
  await expect(restoreToggle).toHaveAttribute("aria-checked", "false")

  await app.close()
  await launchApp()
  window = await app.firstWindow()
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-card").click()
  await expect(window.getByTestId("project-view")).toBeVisible()
  await expect(window.getByTestId("central-tab")).toHaveCount(0)
  await expect(window.getByTestId("central-launcher")).toBeVisible()

  // Keep the shared Electron profile neutral for later E2E cases.
  await window.getByTestId("nav-settings").click()
  await window.getByTestId("settings-restore-project-tabs").click()
  await expect(window.getByTestId("settings-restore-project-tabs")).toHaveAttribute(
    "aria-checked",
    "true",
  )
})

test("closing a terminal tab kills the daemon session", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-card").click()
  await window.getByTestId("central-new-terminal").click()
  const terminal = window.getByTestId("terminal")
  await expect(terminal).toHaveAttribute("data-session-id", /.+/)
  const sessionId = await terminal.getAttribute("data-session-id")
  expect(sessionId).not.toBeNull()

  const daemon = new DaemonClient(join(dataDir, "daemon.sock"))
  await daemon.connect()
  expect((await daemon.list()).map((session) => session.id)).toContain(sessionId)

  await window.getByTestId("central-tab-close").click()
  await expect(window.getByTestId("central-tab")).toHaveCount(0)
  await expect
    .poll(
      async () => (await daemon.list()).find((session) => session.id === sessionId)?.alive ?? false,
    )
    .toBe(false)
  daemon.close()
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

test("Alpha Appearance changes the running icon choice and restores both families after restart", async () => {
  let window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  if (process.platform === "darwin") {
    await app.evaluate(({ app: electronApp }) => {
      const dock = electronApp.dock
      const original = dock.setIcon.bind(dock)
      const probe = globalThis as typeof globalThis & { __piLabDockIconCalls?: string[] }
      probe.__piLabDockIconCalls = []
      dock.setIcon = (icon) => {
        if (typeof icon === "string") probe.__piLabDockIconCalls?.push(icon)
        original(icon)
      }
    })
  }

  await window.getByTestId("nav-settings").click()
  await window.getByTestId("settings-nav-appearance").click()
  await expect(window.getByTestId("settings-section-appearance")).toBeVisible()

  const picker = window.getByTestId("settings-app-icon-picker")
  await expect(picker).toBeVisible()
  await expect(window.getByTestId("settings-app-icon-style")).toHaveValue("25")
  await expect(window.getByTestId("settings-app-icon-palette")).toHaveValue("viridis")
  await expect(window.getByTestId("settings-app-icon-palette")).toBeDisabled()
  await expect(window.getByTestId("settings-app-icon-expanded")).toBeChecked()

  // Check that the preview bridge returns the exact PNG for the selected icon.
  const preview = window.getByTestId("settings-app-icon-preview")
  const previewMatches = async (name: string): Promise<void> => {
    const path =
      name === "icon-alpha.png"
        ? join(HERE, "..", "icons", name)
        : join(
            DESKTOP_DIR,
            "src/renderer/routes/_shell/settings/components/AppIconGallery/channel-icons",
            name,
          )
    const expected = await readFile(path)
    await expect
      .poll(async () => {
        const source = await window.getByTestId("settings-app-icon-preview").getAttribute("src")
        if (!source?.startsWith("data:image/png;base64,")) return false
        return Buffer.from(source.slice("data:image/png;base64,".length), "base64").equals(expected)
      })
      .toBe(true)
  }
  await expect
    .poll(() => preview.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
  await previewMatches("icon-alpha.png")
  await window.getByTestId("settings-app-icon-expanded").uncheck()
  await previewMatches("joyplot-25-alpha.png")
  await expect
    .poll(() => preview.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
  await window.getByTestId("settings-app-icon-next").click()
  await expect(window.getByTestId("settings-app-icon-style")).toHaveValue("26")
  await window.getByTestId("settings-app-icon-style").selectOption("37")
  await previewMatches("joyplot-37-alpha.png")
  await expect
    .poll(() => preview.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
  await window.getByTestId("settings-app-icon-style").selectOption("33")
  await window.getByTestId("settings-app-icon-expanded").check()
  await previewMatches("joyplot-33-alpha-expanded.png")
  if (process.platform === "darwin") {
    await expect
      .poll(() =>
        app.evaluate(() =>
          (
            globalThis as typeof globalThis & { __piLabDockIconCalls?: string[] }
          ).__piLabDockIconCalls?.at(-1),
        ),
      )
      .toMatch(/joyplot-33-alpha-expanded\.png$/)
  }
  await expect
    .poll(() => preview.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)

  await window.getByTestId("settings-app-icon-family").selectOption("pi")
  await expect(window.getByTestId("settings-app-icon-font")).toHaveValue("helvetica-neue-medium")
  await expect(preview).toHaveAttribute("alt", "Pi Lab helvetica-neue-medium, Viridis")
  await previewMatches("pi-helvetica-neue-medium-alpha.png")
  await expect
    .poll(() => preview.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
  await window.getByTestId("settings-app-icon-font").selectOption("didot-bold")
  await expect(preview).toHaveAttribute("alt", "Pi Lab didot-bold, Viridis")
  await previewMatches("pi-didot-bold-alpha.png")
  await expect
    .poll(() => preview.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
  await expect
    .poll(async () => JSON.parse(await readFile(join(dataDir, "app-icon-selection.json"), "utf8")))
    .toMatchObject({
      family: "pi",
      joyplotStyle: "33",
      joyplotPalette: "viridis",
      joyplotExpanded: true,
      piFont: "didot-bold",
      piPalette: "viridis",
    })

  await app.close()
  await launchApp()
  window = await app.firstWindow()
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("nav-settings").click()
  await window.getByTestId("settings-nav-appearance").click()
  await expect(window.getByTestId("settings-app-icon-family")).toHaveValue("pi")
  await expect(window.getByTestId("settings-app-icon-font")).toHaveValue("didot-bold")
  await expect(window.getByTestId("settings-app-icon-palette")).toHaveValue("viridis")
  await window.getByTestId("settings-app-icon-family").selectOption("joyplot")
  await expect(window.getByTestId("settings-app-icon-style")).toHaveValue("33")
  await expect(window.getByTestId("settings-app-icon-palette")).toHaveValue("viridis")
  await expect(window.getByTestId("settings-app-icon-expanded")).toBeChecked()
  await previewMatches("joyplot-33-alpha-expanded.png")
})
