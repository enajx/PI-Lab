import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

const mainEntry = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "apps",
  "desktop",
  "out",
  "main",
  "index.js",
)
const desktop = join(dirname(mainEntry), "..", "..")
const electronPath = createRequire(join(desktop, "package.json"))("electron") as string
const execFileAsync = promisify(execFile)

/** Clicking Quit closes its own Playwright page before the click promise can settle. */
async function quitFromTray(
  app: ElectronApplication,
  tray: Awaited<ReturnType<ElectronApplication["firstWindow"]>>,
): Promise<void> {
  const quit = tray.getByRole("button", { name: "Quit" })
  await expect(quit).toBeVisible()
  const closed = app.waitForEvent("close")
  const click = quit.click().catch((error: unknown) => {
    if (!String(error).includes("Target page, context or browser has been closed")) throw error
  })
  await Promise.all([closed, click])
}

/** A hidden login launch keeps the full services running and opens from its real popover. */
test("hidden startup opens PI Lab from the background tray", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-background-tray-"))
  const file = join(dir, "from-tray.py")
  await writeFile(file, "tray_file = 1\n")
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry, "--pi-lab-background"],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_TEST_SHOW_TRAY: "1",
        PI_LAB_TEST_PICK_FILE: file,
        PI_LAB_DATA_DIR: join(dir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dir, "daemon.sock"),
      },
    })
    const tray = await app.firstWindow()
    await expect(tray.getByTestId("tray-popover")).toBeVisible()
    await expect(tray.getByText("No active projects")).toBeVisible()
    await tray.getByRole("button", { name: "Open PI Lab" }).click()
    const full = await app.waitForEvent("window", {
      predicate: (window) => window !== tray,
    })
    await expect(full.locator("body")).toContainText("Projects")
    const nextTray = app.waitForEvent("window", {
      predicate: (window) => window !== tray && window !== full,
    })
    await full.close()
    const reopenedTray = await nextTray
    await expect(reopenedTray.getByTestId("tray-popover")).toBeVisible()
    const quickWindow = app.waitForEvent("window", {
      predicate: (window) => window !== tray && window !== full && window !== reopenedTray,
    })
    await reopenedTray.getByRole("button", { name: "Open File" }).click()
    const quick = await quickWindow
    await expect(quick.getByTestId("quick-editor").locator(".cm-content")).toBeFocused()
    await expect(quick.getByTestId("quick-editor")).toContainText("tray_file = 1")
    const finalTray = app.waitForEvent("window", {
      predicate: (window) =>
        window !== tray && window !== full && window !== reopenedTray && window !== quick,
    })
    await quick.evaluate(() => window.close())
    const quickClosedTray = await finalTray
    await expect(quickClosedTray.getByTestId("tray-popover")).toBeVisible()
    const reopenedFull = app.waitForEvent("window", {
      predicate: (window) =>
        window !== tray &&
        window !== full &&
        window !== reopenedTray &&
        window !== quick &&
        window !== quickClosedTray,
    })
    await app.evaluate(({ app }) =>
      app.emit("second-instance", {} as never, [process.execPath], process.cwd()),
    )
    const fullAgain = await reopenedFull
    await expect(fullAgain.getByTestId("quick-editor-full-app")).toBeVisible()
    const finalPopover = app.waitForEvent("window", {
      predicate: (window) =>
        window !== tray &&
        window !== full &&
        window !== reopenedTray &&
        window !== quick &&
        window !== quickClosedTray &&
        window !== fullAgain,
    })
    await fullAgain.evaluate(() => window.close())
    const quitTray = await finalPopover
    await quitFromTray(app, quitTray)
    app = null
  } finally {
    await app?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

/** Turning off background mode exits after the last approved window close. */
test("closing the last window quits when background mode is off", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-no-background-"))
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: join(dir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dir, "daemon.sock"),
      },
    })
    const window = await app.firstWindow()
    await expect(window.getByTestId("app-ready")).toBeVisible()
    await window.getByTestId("nav-settings").click()
    const toggle = window.getByTestId("settings-keep-running-after-close")
    await expect(toggle).toHaveAttribute("aria-checked", "true")
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-checked", "false")
    const closed = app.waitForEvent("close")
    await window.evaluate(() => window.close())
    await closed
    app = null

    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry, "--pi-lab-background"],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_TEST_SHOW_TRAY: "1",
        PI_LAB_DATA_DIR: join(dir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dir, "daemon.sock"),
      },
    })
    const tray = await app.firstWindow()
    await expect(tray.getByTestId("tray-popover")).toBeVisible()
    const reopened = app.waitForEvent("window", { predicate: (next) => next !== tray })
    await tray.getByRole("button", { name: "Open PI Lab" }).click()
    const full = await reopened
    await expect(full.getByTestId("app-ready")).toBeVisible()
    const closedAfterLogin = app.waitForEvent("close")
    await full.evaluate(() => window.close())
    await closedAfterLogin
    app = null
  } finally {
    await app?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

/** A live agent appears in the popover and its row opens that project. */
test("working project appears in the tray and opens its full project view", async () => {
  test.setTimeout(60_000)
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-tray-project-"))
  const repo = join(dir, "repo")
  let app: ElectronApplication | null = null
  try {
    await execFileAsync("git", ["init", "-b", "main", repo])
    await writeFile(join(repo, "README.md"), "# Project\n")
    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_TEST_SHOW_TRAY: "1",
        PI_LAB_TEST_OPEN_PROJECT: repo,
        PI_LAB_TEST_AGENT_ID: "test-echo",
        PI_LAB_DATA_DIR: join(dir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dir, "daemon.sock"),
      },
    })
    const window = await app.firstWindow()
    await expect(window.getByTestId("app-ready")).toBeVisible()
    await window.getByTestId("project-item").click()
    await window.getByTestId("central-new-agent").click()
    const chooser = window.getByTestId("new-agent-dialog")
    await chooser.locator("label", { hasText: "Test Activity" }).click()
    await chooser.getByRole("button", { name: "Start agent" }).click()
    await expect(window.getByTestId("terminal")).toContainText("AGENT-ACTIVE")

    const trayWindow = app.waitForEvent("window", { predicate: (next) => next !== window })
    await window.evaluate(() => window.close())
    const tray = await trayWindow
    const project = tray.getByRole("button", { name: /repo.*Working/ })
    await expect(project).toBeVisible()
    const opened = app.waitForEvent("window", {
      predicate: (next) => next !== window && next !== tray,
    })
    await project.click()
    const full = await opened
    await expect(full.getByTestId("project-view")).toBeVisible()

    const lastTray = app.waitForEvent("window", {
      predicate: (next) => next !== window && next !== tray && next !== full,
    })
    await full.evaluate(() => window.close())
    const quitTray = await lastTray
    await quitFromTray(app, quitTray)
    app = null
  } finally {
    await app?.close()
    await rm(dir, { recursive: true, force: true })
  }
})
