import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { DaemonClient } from "../../packages/pty-daemon/src/index"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  test,
} from "./fixtures/playwright"

// Exercises the dashboard with a temporary repo in the real Electron build.

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional real packaged app verification.
const packagedBinary = process.env.PI_LAB_PACKAGED_BINARY

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
    executablePath: packagedBinary ?? ELECTRON_PATH,
    args: packagedBinary ? [] : [MAIN_ENTRY],
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

/** Quit-policy behavior is tested separately; accept stopping fixture agents on cleanup. */
async function closeApp(): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const showMessageBox = dialog.showMessageBox.bind(dialog)
    dialog.showMessageBox = async (...args: Parameters<typeof dialog.showMessageBox>) => {
      const options = args.length === 1 ? args[0] : args[1]
      const response = options?.buttons?.indexOf("Quit and stop agents") ?? -1
      if (response >= 0) return { response, checkboxChecked: false }
      return showMessageBox(...args)
    }
  })
  await app.close()
}

test.afterEach(async () => {
  await closeApp()
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
  const panel = window.getByRole("dialog", { name: "Agents status" })
  await expect(panel).toBeVisible()
  await expect(panel).toContainText("Claude Code")
  await expect(panel).toContainText("Codex")
  await expect(panel).toContainText("Current sessions")
  await expect(panel).toContainText("No current sessions.")
})

test("title bar bug menu opens the prefilled GitHub issue forms", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  // Record the URL instead of opening the browser.
  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as { openedUrls?: string[] }).openedUrls = opened
    shell.openExternal = async (url: string) => {
      opened.push(url)
    }
  })
  // A source run is Alpha: it names the git commit, since its version is 0.0.0.
  const commit = (
    await execFileAsync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: DESKTOP_DIR })
  ).stdout.trim()
  const macosVersion = await app.evaluate(() => process.getSystemVersion())
  const expected = `PI Lab Alpha ${commit}, macOS ${macosVersion}`
  const control = window.getByTestId("issue-report-control")
  const issueBounds = await control.boundingBox()
  const agentBounds = await window.getByTestId("agent-status-control").boundingBox()
  const caffeineBounds = await window.getByTestId("caffeine-control").boundingBox()
  if (!issueBounds || !agentBounds || !caffeineBounds) throw new Error("Title bar button missing")
  // Same 8px gap as the other views' title bar buttons.
  expect(agentBounds.x - (issueBounds.x + issueBounds.width)).toBe(8)
  expect(caffeineBounds.x - (agentBounds.x + agentBounds.width)).toBe(8)
  for (const [name, template] of [
    ["Report a bug", "bug_report.yml"],
    ["Request a feature", "feature_request.yml"],
  ] as const) {
    await control.click()
    const menu = window.getByRole("menu", { name: "Report an issue" })
    await expect(menu.getByRole("menuitem")).toHaveText(["Report a bug", "Request a feature"])
    await menu.getByRole("menuitem", { name }).click()
    await expect(menu).toBeHidden()
    const url = new URL(
      await app.evaluate(() => (globalThis as { openedUrls?: string[] }).openedUrls?.at(-1) ?? ""),
    )
    expect(url.origin + url.pathname).toBe("https://github.com/enajx/PI-Lab/issues/new")
    expect(url.searchParams.get("template")).toBe(template)
    expect(url.searchParams.get("environment")).toBe(expected)
  }
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
  await editDialog.getByTestId("edit-project-type").selectOption("software")
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

  // It carries a status badge and starts at the default shared size, with a
  // keyboard-accessible, visually quiet corner handle rather than a toolbar slider.
  // Arrow keys step 10%: left/right change the width, up/down the height.
  await expect(window.getByTestId("project-card-status")).toBeVisible()
  await expect(window.getByTestId("card-size-slider")).toHaveCount(0)
  const grid = window.getByTestId("dashboard-grid")
  const item = window.getByTestId("project-card-grid-item")
  const resizeHandle = window.getByTestId("card-resize-handle")
  await expect(grid).toHaveAttribute("data-card-grid-base-column", "220")
  await expect(grid).toHaveAttribute("data-card-grid-width", "1")
  await expect(grid).toHaveAttribute("data-card-grid-height", "1")
  await expect(item).toHaveAttribute("data-card-span", "1x1")
  await resizeHandle.focus()
  await window.keyboard.press("ArrowRight")
  await expect(grid).toHaveAttribute("data-card-grid-width", "1.1")
  await expect(grid).toHaveAttribute("data-card-grid-height", "1")
  await expect
    .poll(() => item.evaluate((element) => element.getBoundingClientRect().width))
    .toBe(242)
  const imageHeight = () => image.evaluate((element) => element.getBoundingClientRect().height)
  const baseImageHeight = await imageHeight()
  await window.keyboard.press("ArrowDown")
  await expect(grid).toHaveAttribute("data-card-grid-height", "1.1")
  await expect(item).toHaveAttribute("data-card-span", "1x1")
  // A taller card has a taller thumbnail, in the same proportion as the card.
  await expect.poll(imageHeight).toBe(Math.round(baseImageHeight * 1.1))
  await window.screenshot({ path: resolve(".cache", "screens", "dashboard-card-taller.png") })

  // A corner drag changes width and height separately, in 10% steps.
  const handleBox = await resizeHandle.boundingBox()
  if (!handleBox) throw new Error("Expected the card resize handle to have a box")
  const startX = handleBox.x + handleBox.width / 2
  const startY = handleBox.y + handleBox.height / 2
  await window.mouse.move(startX, startY)
  await window.mouse.down()
  await window.mouse.move(startX + 44, startY, { steps: 4 })
  await window.mouse.up()
  await expect(grid).toHaveAttribute("data-card-grid-width", "1.3")
  await expect(grid).toHaveAttribute("data-card-grid-height", "1.1")

  // The shared size keeps the grid within a narrow viewport without horizontal overflow.
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

  // The grain is one baked noise image drawn once over the whole cover. Small
  // repeating background tiles (e.g. 5px/7px dot screens) show as a mesh.
  const grain = await window
    .getByTestId("project-card-gradient-grain")
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element)
      return { backgroundImage: style.backgroundImage, backgroundRepeat: style.backgroundRepeat }
    })
  // Count CSS image layers; `url(%23…)` refs inside the encoded SVG are not layers.
  expect(grain.backgroundImage.match(/url\("|gradient\(/g)).toHaveLength(1)
  expect(grain.backgroundImage).toContain("data:image/svg+xml")
  expect(grain.backgroundRepeat).toBe("no-repeat")
})

test("Project summary stays viewport-sized when opened from a hovered card", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })

  const card = window.getByTestId("project-card")
  const status = card.getByTestId("project-card-status-button")
  await expect(status).toBeVisible({ timeout: 30_000 })

  await status.hover()
  await status.click()
  await expect(window.getByTestId("project-status-update-summary")).toBeVisible()
  await window.screenshot({ path: test.info().outputPath("project-status.png") })
  await window.getByTestId("project-status-update-summary").click()

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
  await window.getByTestId("central-add-menu").click()
  await window.getByTestId("central-add-agent").click()
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
  await expect(window.getByTestId("dashboard-empty")).toHaveCount(0)
  await expect(newProjectCard).toBeVisible()
  expect(
    await grid.evaluate((element) => element.lastElementChild?.getAttribute("data-testid")),
  ).toBe("new-project-card")
})

test("New Project from the tray opens the shared chooser", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.goto(`${window.url().split("#")[0]}#/?newProject=1`)
  await window.reload()
  await expect(window.getByTestId("add-project-menu")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("add-project-folder")).toBeVisible()
  await expect.poll(() => window.url()).not.toContain("newProject=1")
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

  await closeApp()
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

test("project view tab rows are no taller than the toolbar row above them", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-card").click()
  await expect(window.getByTestId("project-view")).toBeVisible()
  await window.getByTestId("panel-tab-files").click()
  await window.getByTestId("file-tree-file").click()
  await expect(window.getByTestId("central-tab")).toContainText("README.md")
  await window.getByTestId("central-new-terminal").click()
  await expect(window.getByTestId("terminal")).toHaveAttribute("data-session-id", /.+/)

  const heightOf = (locator: Locator) =>
    locator.evaluate((element) => element.getBoundingClientRect().height)
  // The toolbar row holds the files-panel toggle and the +, agent, terminal, file, settings buttons.
  const toolbarRow = window.getByTestId("central-files-toggle").locator("xpath=../..")
  const toolbarHeight = await heightOf(toolbarRow)
  const tabRows = window.getByTestId("central-panel").locator(".dv-tabs-and-actions-container")
  expect(await tabRows.count()).toBeGreaterThan(0)
  for (const row of await tabRows.all()) {
    expect(await heightOf(row)).toBeLessThanOrEqual(toolbarHeight)
  }
  // The tabs fit inside the row and keep readable 12px text.
  for (const tab of await window.getByTestId("central-tab").all()) {
    expect(await heightOf(tab)).toBeLessThanOrEqual(toolbarHeight)
    expect(await tab.evaluate((element) => getComputedStyle(element).fontSize)).toBe("12px")
  }
  await window.screenshot({ path: resolve(".cache", "screens", "project-view-tab-rows.png") })
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
  await expect(window.getByTestId("terminal").filter({ hasText: "AGENT-UI-OK" })).toBeVisible({
    timeout: 30_000,
  })
  const originalAgentId = await window
    .getByTestId("terminal")
    .filter({ hasText: "AGENT-UI-OK" })
    .getAttribute("data-session-id")

  await closeApp()
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

  await closeApp()
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
  const session = (await daemon.list()).find((entry) => entry.id === sessionId)
  expect(session?.alive).toBe(true)
  const shellPid = session?.pid
  expect(shellPid).toBeGreaterThan(0)

  await window.getByTestId("central-tab-close").click()
  await expect(window.getByTestId("central-tab")).toHaveCount(0)
  await expect
    .poll(
      async () => (await daemon.list()).find((session) => session.id === sessionId)?.alive ?? false,
    )
    .toBe(false)
  expect(() => process.kill(shellPid as number, 0)).toThrow(/ESRCH/)
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

test("the card title has its own line with the agent status below it", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const card = window.getByTestId("project-card")
  await expect(card).toBeVisible({ timeout: 30_000 })
  const title = card.getByTestId("project-card-title")
  const status = card.getByTestId("project-card-status")
  await expect(status).toHaveText("No active agents")
  await expect(card.getByTestId("project-card-stage")).toBeVisible()
  const open = await card.getByTestId("project-card-open").boundingBox()
  const titleBox = await title.boundingBox()
  const statusBox = await status.boundingBox()
  if (!open || !titleBox || !statusBox)
    throw new Error("Project card title or status is not visible")
  // The title spans the card's text area (its padding aside), and the status starts below it.
  expect(titleBox.width).toBeGreaterThan(open.width - 24)
  expect(statusBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height)
  await card.screenshot({ path: resolve(".cache", "screens", "card-title.png") })
})

test("the project stage set in Edit project shows in the project view and survives a restart", async () => {
  let window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const card = window.getByTestId("project-card")
  await expect(card).toBeVisible({ timeout: 30_000 })

  // Edit project has a Project status row; a new project has no step filled.
  await card.getByTestId("project-card-body").click({ button: "right", position: { x: 24, y: 24 } })
  await window.getByTestId("project-card-menu").getByTestId("project-card-menu-edit").click()
  const editDialog = window.getByTestId("edit-project-dialog")
  const editStage = editDialog.getByTestId("edit-project-stage")
  await expect(editDialog.getByText("Project status")).toBeVisible()
  await expect(editStage.locator('[data-filled="true"]')).toHaveCount(0)

  // Clicking Experiments fills Planning and Experiments; Experiments is current.
  await editStage.getByTestId("edit-project-stage-step-experiments").click()
  await expect(editStage.getByTestId("edit-project-stage-step-experiments")).toHaveAttribute(
    "aria-current",
    "step",
  )
  await expect(editStage.getByTestId("edit-project-stage-step-planning")).toHaveAttribute(
    "data-filled",
    "true",
  )
  await editDialog.getByTestId("edit-project-cancel").click()
  await expect(editDialog).toHaveCount(0)

  // The project view top bar shows the same stage.
  await card.getByTestId("project-card-open").click()
  const viewStage = window.getByTestId("project-view-stage")
  await expect(viewStage.getByTestId("project-view-stage-step-experiments")).toHaveAttribute(
    "aria-current",
    "step",
  )

  // Hovering a step: its tooltip is the step's name, and the What's this? card shows
  // "Project status" with that step, what a click does, and the current stage.
  await expect(viewStage).toHaveAttribute("title", "Project status")
  const planning = viewStage.getByTestId("project-view-stage-step-planning")
  await expect(planning).toHaveAttribute("title", "Planning")
  await planning.hover()
  const help = window.getByTestId("sidebar-feature-help")
  await expect(help.getByTestId("sidebar-feature-help-label")).toHaveText("Project status")
  await expect(help.getByTestId("sidebar-feature-help-description")).toHaveText(
    "Planning: click to set. Current: Experiments.",
  )
  await window.screenshot({ path: resolve(".cache", "screens", "stage-hint.png") })

  // Clicking the current step moves back one step.
  await viewStage.getByTestId("project-view-stage-step-experiments").click()
  await expect(viewStage.getByTestId("project-view-stage-step-planning")).toHaveAttribute(
    "aria-current",
    "step",
  )

  await closeApp()
  await launchApp()
  window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window
    .getByTestId("project-card")
    .getByTestId("project-card-open")
    .click({ timeout: 30_000 })
  await expect(
    window.getByTestId("project-view-stage").getByTestId("project-view-stage-step-planning"),
  ).toHaveAttribute("aria-current", "step", { timeout: 30_000 })
})

test("dragging a project card moves it on the Dashboard and in the sidebar, and the order survives a restart", async () => {
  // Add two more projects by launching with each one in turn: a new project goes first.
  for (const [index, name] of ["repo", "beta", "gamma"].entries()) {
    if (index > 0) {
      await closeApp()
      repoDir = join(dataDir, name)
      await initRepo(repoDir)
      await launchApp()
    }
    // Wait until the seam has opened this project before going on.
    await expect((await app.firstWindow()).getByTestId("project-card")).toHaveCount(index + 1, {
      timeout: 30_000,
    })
  }
  let window = await app.firstWindow()
  await window.setViewportSize({ width: 1200, height: 800 })
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const cardTitles = window.getByTestId("project-card-title")
  await expect(cardTitles).toHaveText(["gamma", "beta", "repo"], { timeout: 30_000 })
  const sidebarOrder = () =>
    window
      .getByTestId("project-item")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-project-id")))
  const cardOrder = () =>
    window
      .getByTestId("project-card")
      .evaluateAll((cards) => cards.map((card) => card.getAttribute("data-project-id")))
  await expect.poll(sidebarOrder).toEqual(await cardOrder())

  // Drag the first card's thumbnail onto the second card with the mouse.
  const images = window.getByTestId("project-card-image")
  const from = await images.nth(0).boundingBox()
  const to = await images.nth(1).boundingBox()
  if (!from || !to) throw new Error("Expected measurable project cards")
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
  const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 }
  await window.mouse.move(start.x, start.y)
  await window.mouse.down()
  await window.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 8 })
  await window.mouse.move(end.x, end.y, { steps: 8 })
  await expect(
    window.locator('[data-testid="project-card-grid-item"][data-dragging="true"]'),
  ).toHaveCount(1)
  await window.screenshot({ path: resolve(".cache", "screens", "card-drag.png") })
  await window.mouse.up()

  // The drop moved the card and did not open the project.
  await expect(cardTitles).toHaveText(["beta", "gamma", "repo"])
  await expect(window.getByTestId("dashboard")).toBeVisible()
  await expect.poll(sidebarOrder).toEqual(await cardOrder())

  // A plain click still opens a project.
  await images.nth(0).click()
  await expect(window.getByTestId("project-view")).toBeVisible()
  await window.getByTestId("nav-dashboard").click()
  await expect(cardTitles).toHaveText(["beta", "gamma", "repo"])

  // The restart also opens "gamma" again through the test seam; opening keeps the order.
  await closeApp()
  await launchApp()
  window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-card-title")).toHaveText(["beta", "gamma", "repo"], {
    timeout: 30_000,
  })
  await expect.poll(sidebarOrder).toEqual(await cardOrder())
})
