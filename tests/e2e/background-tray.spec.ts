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

/** A hidden login launch shows the compact monitor and can open the full app. */
test("hidden startup shows the project monitor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-background-tray-"))
  let app: ElectronApplication | null = null
  try {
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
    await expect(tray.getByText("No active projects")).toBeVisible()
    await expect(tray.getByText("Active projects", { exact: true })).toBeVisible()
    expect(await tray.evaluate(() => window.innerHeight)).toBeLessThanOrEqual(75)
    await expect(tray.getByRole("button", { name: "Open PI Lab" })).toHaveCount(0)
    await expect(tray.getByRole("button", { name: "Open File" })).toHaveCount(0)
    await expect(tray.getByRole("button", { name: "Quit" })).toHaveCount(0)
    const fullWindow = app.waitForEvent("window", {
      predicate: (window) => window !== tray,
    })
    await app.evaluate(({ app }) =>
      app.emit("second-instance", {} as never, [process.execPath], process.cwd()),
    )
    const full = await fullWindow
    await expect(full.locator("body")).toContainText("Projects")
    const nextTray = app.waitForEvent("window", {
      predicate: (window) => window !== tray && window !== full,
    })
    await full.close()
    const reopenedTray = await nextTray
    await expect(reopenedTray.getByTestId("tray-popover")).toBeVisible()
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
    await app.evaluate(({ app }) =>
      app.emit("second-instance", {} as never, [process.execPath], process.cwd()),
    )
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

test("hidden menu-bar icon persists and app activation reopens PI Lab", async () => {
  test.skip(process.platform !== "darwin", "macOS menu-bar setting")
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-hidden-menu-icon-"))
  const dataDir = join(dir, "app-data")
  let app: ElectronApplication | null = null
  const launch = () =>
    electron.launch({
      executablePath: electronPath,
      args: [mainEntry],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_TEST_SHOW_TRAY: "1",
        PI_LAB_DATA_DIR: dataDir,
        PI_LAB_SOCKET_PATH: join(dir, "daemon.sock"),
      },
    })
  try {
    app = await launch()
    let window = await app.firstWindow()
    await expect(window.getByTestId("app-ready")).toBeVisible()
    await window.getByTestId("nav-settings").click()
    let toggle = window.getByTestId("settings-menu-bar-icon")
    await expect(toggle).toHaveAttribute("aria-checked", "true")
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-checked", "false")
    await app.close()

    app = await launch()
    window = await app.firstWindow()
    await expect(window.getByTestId("app-ready")).toBeVisible()
    await window.getByTestId("nav-settings").click()
    toggle = window.getByTestId("settings-menu-bar-icon")
    await expect(toggle).toHaveAttribute("aria-checked", "false")
    await window.evaluate(() => window.close())
    await expect
      .poll(() => app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(0)

    const reopened = app.waitForEvent("window")
    await app.evaluate(({ app: electronApp }) => electronApp.emit("activate"))
    window = await reopened
    await expect(window.getByTestId("app-ready")).toBeVisible()
    await window.getByTestId("nav-settings").click()
    toggle = window.getByTestId("settings-menu-bar-icon")
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-checked", "true")
    const trayWindow = app.waitForEvent("window", { predicate: (next) => next !== window })
    await window.evaluate(() => window.close())
    await expect((await trayWindow).getByTestId("tray-popover")).toBeVisible()
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
    await project.locator(".tray-project-state").click()
    const full = await opened
    await expect(full.getByTestId("project-view")).toBeVisible()
  } finally {
    await app?.close()
    await rm(dir, { recursive: true, force: true })
  }
})
