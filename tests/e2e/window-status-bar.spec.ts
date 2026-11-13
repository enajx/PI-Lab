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

/**
 * Whole-app E2E for the window status bar and the project view's stage dots.
 * Launches the real build with one Git project and a fixture ssh config (the
 * `PI_LAB_TEST_SSH_CONFIG` seam, so the real `~/.ssh/config` is never read).
 */
const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

const SSH_CONFIG = `
Host gpu-box
  HostName 10.0.0.5
  User researcher

Host laptop
  HostName laptop.local

Host *
  ServerAliveInterval 60
`

let app: ElectronApplication
let dataDir: string
let repoDir: string

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-status-bar-"))
  repoDir = join(dataDir, "repo")
  await execFileAsync("git", ["init", "-b", "main", repoDir])
  const run = (args: string[]) => execFileAsync("git", ["-C", repoDir, ...args])
  await run(["config", "user.email", "test@pi-lab.local"])
  await run(["config", "user.name", "PI Lab Test"])
  await writeFile(join(repoDir, "RESEARCH.md"), "# Fixture\n")
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
  const sshConfig = join(dataDir, "ssh-config")
  await writeFile(sshConfig, SSH_CONFIG)
  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: repoDir,
      PI_LAB_TEST_SSH_CONFIG: sshConfig,
    },
  })
})

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

/** Open the project view from its Dashboard card. */
async function openProject(page: Page): Promise<void> {
  await page.getByTestId("nav-dashboard").click()
  await page.getByTestId("project-card").getByTestId("project-card-body").click()
  await expect(page.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
}

test("the status bar is off by default, turns on from the palette and off in Settings, and shows its items", async () => {
  const page = await app.firstWindow()
  await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const bar = page.getByTestId("window-status-bar")
  await expect(bar).toHaveCount(0)

  // Command palette: Turn on Status bar.
  await page.keyboard.press("ControlOrMeta+Shift+p")
  await page.getByTestId("command-palette-input").fill("status bar")
  const command = page.locator('[data-command-id="settings-status-bar"]')
  await expect(command).toContainText("Turn on Status bar")
  await command.click()
  await expect(bar).toBeVisible()

  await openProject(page)
  // It is the window's bottom row, below the sidebar and the project view.
  const height = await page.evaluate(() => window.innerHeight)
  const box = await bar.boundingBox()
  expect(box && Math.round(box.y + box.height)).toBe(height)

  await expect(bar.getByTestId("status-bar-project")).toHaveText("repo")
  const branch = bar.getByTestId("status-bar-branch")
  await expect(branch).toHaveText("main")
  await expect(branch).toHaveAttribute("data-dirty", "false")
  await writeFile(join(repoDir, "changed.txt"), "x\n")
  await expect(branch).toHaveAttribute("data-dirty", "true", { timeout: 20_000 })
  await expect(branch).toHaveText("main*")

  await expect(bar.getByTestId("status-bar-agents")).toHaveText("0 agents")
  // Caffeine mode follows the title-bar control.
  await expect(bar.getByTestId("status-bar-caffeine")).toHaveText("Caffeine off")
  await page.getByTestId("caffeine-control").first().click()
  await expect(bar.getByTestId("status-bar-caffeine")).toHaveText("Caffeine on")
  await expect(bar.getByTestId("status-bar-version")).toHaveText(/^Alpha ([0-9a-f]{8}|dev)$/)
  await expect(bar.getByTestId("status-bar-palette-hint")).toHaveText(/P Commands$/)

  // Every item has a "What's this?" text, like other controls.
  const help = page.getByTestId("sidebar-feature-help")
  const expectHelp = async (testId: string, label: string): Promise<void> => {
    await bar.getByTestId(testId).hover()
    await expect(help.getByTestId("sidebar-feature-help-label")).toHaveText(label)
    await expect(help.getByTestId("sidebar-feature-help-description")).not.toHaveText("")
  }
  await expectHelp("status-bar-project", "Current project")
  await expectHelp("status-bar-branch", "Git branch")
  await expectHelp("status-bar-agents", "Running agents")
  await expectHelp("status-bar-caffeine", "Caffeine")
  await expectHelp("status-bar-version", "Channel and version")
  await expectHelp("status-bar-palette-hint", "Command palette")
  await expectHelp("status-bar-hosts", "SSH hosts")

  // N hosts lists the ssh config's concrete hosts.
  const hosts = bar.getByTestId("status-bar-hosts")
  await expect(hosts).toHaveText("2 hosts")
  await hosts.click()
  const popover = page.getByTestId("status-bar-hosts-popover")
  await expect(popover.getByTestId("status-bar-host")).toHaveText([
    /gpu-box.*researcher@10\.0\.0\.5/,
    /laptop.*laptop\.local/,
  ])
  await page.screenshot({ path: test.info().outputPath("status-bar.png") })
  await page.keyboard.press("Escape")
  await expect(popover).toHaveCount(0)

  // Views with a project picker show the project they have selected, and its branch.
  for (const tab of ["latex", "analysis", "skills"]) {
    await page.locator(`[data-testid="science-nav-item"][data-science-tab="${tab}"]`).click()
    await expect(bar.getByTestId("status-bar-project")).toHaveText("repo")
    await expect(bar.getByTestId("status-bar-branch")).toHaveText("main*")
  }
  // Tasks starts on All projects, and the Dashboard has no selected project.
  await page.locator('[data-testid="science-nav-item"][data-science-tab="tasks"]').click()
  await expect(bar.getByTestId("status-bar-project")).toHaveCount(0)
  await page.getByTestId("nav-dashboard").click()
  await expect(bar.getByTestId("status-bar-project")).toHaveCount(0)

  // Settings > Appearance: the switch is on; turning it off hides the bar.
  await page.getByTestId("nav-settings").click()
  await page.getByTestId("settings-nav-appearance").click()
  const toggle = page.getByTestId("settings-status-bar")
  await expect(toggle).toHaveAttribute("aria-checked", "true")
  await toggle.click()
  await expect(bar).toHaveCount(0)
  await toggle.click()
  await expect(bar).toBeVisible()
})

test("the project stage dots are centered on the top bar, and sit after the title when the window is narrow", async () => {
  const page = await app.firstWindow()
  await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const setWidth = (width: number) =>
    app.evaluate(({ BrowserWindow }, next) => {
      const [main] = BrowserWindow.getAllWindows()
      main?.setSize(next, 800)
    }, width)
  await setWidth(1600)
  await openProject(page)
  const header = page.getByTestId("project-view-header")
  const dots = page.getByTestId("project-view-stage-slot")
  const title = page.getByTestId("project-view-title")
  await expect(dots).toHaveAttribute("data-placement", "center")
  const wide = await Promise.all([header.boundingBox(), dots.boundingBox()])
  const [headerBox, dotsBox] = wide
  if (!headerBox || !dotsBox) throw new Error("project header is not visible")
  expect(
    Math.abs(dotsBox.x + dotsBox.width / 2 - (headerBox.x + headerBox.width / 2)),
  ).toBeLessThanOrEqual(1)

  await setWidth(720)
  await expect(dots).toHaveAttribute("data-placement", "after-title")
  const [titleBox, narrowDots] = await Promise.all([title.boundingBox(), dots.boundingBox()])
  if (!titleBox || !narrowDots) throw new Error("project header is not visible")
  expect(narrowDots.x).toBeGreaterThanOrEqual(titleBox.x + titleBox.width)
  expect(narrowDots.x - (titleBox.x + titleBox.width)).toBeLessThanOrEqual(16)
})
