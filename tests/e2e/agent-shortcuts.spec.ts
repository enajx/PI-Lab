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
 * Whole-app E2E for the Dashboard and waiting-agent shortcuts. It launches the real
 * build in test mode with one opened project and uses the deterministic "Test
 * Waiting" agent (a local Node one-liner that prints a permission prompt and stays
 * alive), never a real agent CLI. The activity monitor classifies that prompt as
 * waiting for input, so ⌥Tab has a real waiting agent to go to.
 */
const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

let app: ElectronApplication
let dataDir: string

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-agent-shortcuts-"))
  const repo = join(dataDir, "repo")
  await execFileAsync("git", ["init", "-b", "main", repo])
  await writeFile(join(repo, "RESEARCH.md"), "# Fixture\n\nbody\n")
  await execFileAsync("git", ["-C", repo, "add", "."])
  await execFileAsync("git", [
    "-C",
    repo,
    "-c",
    "user.email=test@pi-lab.local",
    "-c",
    "user.name=PI Lab Test",
    "commit",
    "-m",
    "initial",
  ])
  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: repo,
    },
  })
})

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

/** Open the project view from the sidebar. */
async function openProject(window: Page): Promise<void> {
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
}

/** Move focus off any terminal, editor or field so Escape is free. */
async function blurFocus(window: Page): Promise<void> {
  await window.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
}

test("⌥Tab opens the agent waiting for input, from the Dashboard", async () => {
  test.setTimeout(90_000)
  const window = await app.firstWindow()
  await openProject(window)
  await window.getByTestId("central-add-menu").click()
  await window.getByTestId("central-add-agent").click()
  const chooser = window.getByTestId("new-agent-dialog")
  await chooser.locator("label", { hasText: "Test Waiting" }).click()
  await chooser.getByRole("button", { name: "Start agent" }).click()
  await expect(window.getByTestId("terminal")).toContainText("Do you want to proceed?")
  const agentTerminal = window.locator('[data-testid="terminal"][data-input-kind="agent"]')
  const sessionId = await agentTerminal.getAttribute("data-session-id")
  expect(sessionId).toBeTruthy()
  // The sidebar dot turns to "paused" once the monitor confirms the agent is waiting.
  await expect(window.getByTestId("project-agent-status")).toHaveAttribute(
    "data-status",
    "paused",
    { timeout: 30_000 },
  )

  // Open a plain terminal so the agent tab is no longer the active one.
  await window.getByTestId("central-add-menu").click()
  await window.getByTestId("central-add-terminal").click()
  await expect(window.locator('[data-testid="central-tab"][data-active="true"]')).toHaveAttribute(
    "data-tab-kind",
    "terminal",
  )

  await window.getByTestId("nav-dashboard").click()
  await expect(window.getByTestId("dashboard")).toBeVisible()
  await window.keyboard.press("Alt+Tab")

  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await expect(window.locator('[data-testid="central-tab"][data-active="true"]')).toHaveAttribute(
    "data-tab-kind",
    "agent",
  )
  await expect(
    window.locator(`[data-testid="terminal"][data-session-id="${sessionId}"]`),
  ).toBeVisible()
})

test("⌥Tab with no waiting agent shows a notice and stays on the Dashboard", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("dashboard")).toBeVisible()
  await window.keyboard.press("Alt+Tab")
  await expect(window.getByTestId("agent-shortcut-notice")).toHaveText(
    "No agent is waiting for input",
  )
  await expect(window.getByTestId("dashboard")).toBeVisible()
})

test("⌘Escape opens the Dashboard from a project view and the Library, but not from the editor", async () => {
  const window = await app.firstWindow()
  await openProject(window)

  // Focus inside the CodeMirror editor keeps the key.
  await window.getByText("RESEARCH.md", { exact: true }).first().click()
  await window.locator(".cm-content").first().click()
  await window.keyboard.press("ControlOrMeta+Escape")
  await expect(window.getByTestId("project-view")).toBeVisible()
  await expect(window.getByTestId("dashboard")).toHaveCount(0)

  await blurFocus(window)
  await window.keyboard.press("ControlOrMeta+Escape")
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })

  // Plain Escape does nothing on the Library page, so this checks the shortcut itself.
  await window.getByRole("link", { name: "Library" }).click()
  await expect(window.getByTestId("dashboard")).toHaveCount(0)
  await blurFocus(window)
  await window.keyboard.press("ControlOrMeta+Escape")
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })
})

test("⌘T in the project view does what the New agent button does", async () => {
  const window = await app.firstWindow()
  await openProject(window)
  await blurFocus(window)
  await window.keyboard.press("ControlOrMeta+t")
  // The robot button starts the remembered agent, or opens the chooser when it is not
  // detected; either is the button's own result.
  const agentTab = window.locator('[data-testid="central-tab"][data-tab-kind="agent"]')
  await expect(agentTab.or(window.getByTestId("new-agent-dialog"))).toBeVisible({
    timeout: 30_000,
  })
  await expect(window.locator('[data-testid="central-tab"][data-tab-kind="terminal"]')).toHaveCount(
    0,
  )
})

test("⌘T opens a plain terminal when Settings > Shortcuts chooses Terminal", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("nav-settings").click()
  await window.getByTestId("settings-nav-shortcuts").click()
  await expect(window.getByTestId("shortcut-new-session")).toHaveText("⌘T")
  await window.getByTestId("settings-new-session-kind").selectOption("terminal")
  await window.getByTestId("settings-back").click()
  await openProject(window)

  await blurFocus(window)
  await window.keyboard.press("ControlOrMeta+t")
  await expect(window.locator('[data-testid="central-tab"][data-tab-kind="terminal"]')).toHaveCount(
    1,
    { timeout: 30_000 },
  )
  await expect(window.locator('[data-testid="terminal"][data-input-kind="terminal"]')).toBeVisible()

  // A second ⌘T from inside the focused terminal opens another one (macOS: Cmd is not
  // a shell key; elsewhere Ctrl+T stays with the shell).
  if (process.platform === "darwin") {
    await window.locator(".xterm").first().click()
    await window.keyboard.press("Meta+t")
    await expect(
      window.locator('[data-testid="central-tab"][data-tab-kind="terminal"]'),
    ).toHaveCount(2, { timeout: 30_000 })
  }
})

test("⌘T in Tasks asks for a project, then opens a session in the Tasks session panel", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.locator('[data-testid="science-nav-item"][data-science-tab="tasks"]').click()
  await expect(window.getByTestId("science-tasks")).toBeVisible({ timeout: 30_000 })
  const panel = window.getByTestId("science-sessions")
  await expect(panel).toHaveAttribute("data-collapsed", "true")

  // "All projects" has no project to start a session in.
  await blurFocus(window)
  await window.keyboard.press("ControlOrMeta+t")
  await expect(window.getByTestId("science-sessions-notice")).toHaveText(
    "Pick a project to open a session",
  )

  await window.getByTestId("tasks-project-select").click()
  await window.getByRole("listbox", { name: "Project filter" }).getByRole("option").nth(1).click()
  await window.getByTestId("science-sessions-collapse").click()
  await blurFocus(window)
  await window.keyboard.press("ControlOrMeta+t")
  // The robot button's own result: the remembered agent, or the chooser when it is not detected.
  const agentTab = panel.locator('[data-testid="central-tab"][data-tab-kind="agent"]')
  await expect(agentTab.or(window.getByTestId("new-agent-dialog"))).toBeVisible({
    timeout: 30_000,
  })
  await expect(panel).toHaveAttribute("data-collapsed", "false")
})

test("⌘T in Analysis opens a terminal in the session panel, kept after leaving the view", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("nav-settings").click()
  await window.getByTestId("settings-nav-shortcuts").click()
  await window.getByTestId("settings-new-session-kind").selectOption("terminal")
  await window.getByTestId("settings-back").click()

  const analysisNav = window.locator(
    '[data-testid="science-nav-item"][data-science-tab="analysis"]',
  )
  await analysisNav.click()
  await expect(window.getByTestId("science-analysis")).toBeVisible({ timeout: 30_000 })
  const panel = window.getByTestId("science-sessions")
  await expect(panel).toHaveAttribute("data-collapsed", "true")

  await blurFocus(window)
  await window.keyboard.press("ControlOrMeta+t")
  await expect(panel).toHaveAttribute("data-collapsed", "false", { timeout: 30_000 })
  await expect(panel.locator('[data-testid="central-tab"][data-tab-kind="terminal"]')).toHaveCount(
    1,
  )
  const terminal = panel.locator('[data-testid="terminal"][data-input-kind="terminal"]')
  const sessionId = await terminal.getAttribute("data-session-id")
  expect(sessionId).toBeTruthy()

  await window.getByTestId("nav-dashboard").click()
  await expect(window.getByTestId("dashboard")).toBeVisible()
  await analysisNav.click()
  await expect(
    window.locator(
      `[data-testid="science-sessions"] [data-testid="terminal"][data-session-id="${sessionId}"]`,
    ),
  ).toBeVisible({ timeout: 30_000 })
})
