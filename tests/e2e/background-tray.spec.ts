import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional real packaged app verification.
const packagedBinary = process.env.PI_LAB_PACKAGED_BINARY
const appArgs = packagedBinary ? [] : [mainEntry]
const execFileAsync = promisify(execFile)

/** A hidden login launch shows the compact monitor and can open the full app. */
test("hidden startup shows the project monitor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-background-tray-"))
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: packagedBinary ?? electronPath,
      args: [...appArgs, "--pi-lab-background"],
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
    await expect(tray.getByText("No recent projects")).toBeVisible()
    await expect(tray.getByText("PI Lab", { exact: true })).toBeVisible()
    expect(await tray.evaluate(() => window.innerHeight)).toBeLessThanOrEqual(75)
    await expect(tray.getByRole("button", { name: "Open PI Lab" })).toHaveCount(0)
    await expect(tray.getByRole("button", { name: "Open File" })).toHaveCount(0)
    await expect(tray.getByRole("button", { name: "Quit" })).toHaveCount(0)
    const fullWindow = app.waitForEvent("window", {
      predicate: (window) => window !== tray,
    })
    await tray.getByTestId("tray-popover").click({ position: { x: 120, y: 55 } })
    const full = await fullWindow
    await expect(full.locator("body")).toContainText("Projects")
    expect(tray.isClosed()).toBe(false)
    await full.close()
    await expect(tray.getByTestId("tray-popover")).toBeVisible()
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
      executablePath: packagedBinary ?? electronPath,
      args: appArgs,
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
      executablePath: packagedBinary ?? electronPath,
      args: [...appArgs, "--pi-lab-background"],
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

test("menu-bar icon is present while the main window is open and survives closing and reopening it", async () => {
  test.skip(process.platform !== "darwin", "macOS menu-bar icon")
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-always-menu-icon-"))
  const dataDir = join(dir, "app-data")
  await mkdir(dataDir)
  await writeFile(join(dataDir, "menu-bar-icon-hidden"), "")
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: packagedBinary ?? electronPath,
      args: appArgs,
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_TEST_SHOW_TRAY: "1",
        PI_LAB_DATA_DIR: dataDir,
        PI_LAB_SOCKET_PATH: join(dir, "daemon.sock"),
      },
    })
    await expect
      .poll(() => app?.windows().some((page) => page.url().includes("index.html")))
      .toBe(true)
    const window = app.windows().find((page) => page.url().includes("index.html"))
    if (!window) throw new Error("Main app window did not open")
    await expect(window.getByTestId("app-ready")).toBeVisible()
    await expect
      .poll(() => app?.windows().some((page) => page.url().includes("tray.html")), {
        timeout: 5000,
      })
      .toBe(true)
    const tray = app.windows().find((page) => page.url().includes("tray.html"))
    if (!tray) throw new Error("Tray not created while main window is open")
    await expect(tray.getByTestId("tray-popover")).toBeVisible()
    await window.getByTestId("nav-settings").click()
    await expect(window.getByTestId("settings-menu-bar-icon")).toHaveCount(0)
    await window.evaluate(() => window.close())
    // Renderer shutdown approval is asynchronous; the forced-visible tray is not a close signal.
    await expect.poll(() => window.isClosed()).toBe(true)
    await expect(tray.getByTestId("tray-popover")).toBeVisible()
    const reopened = app.waitForEvent("window", {
      predicate: (page) => page !== tray && page !== window,
    })
    await tray.getByTestId("tray-popover").click({ position: { x: 120, y: 55 } })
    const full = await reopened
    await expect(full.getByTestId("app-ready")).toBeVisible()
    expect(tray.isClosed()).toBe(false)
    await full.close()
    await expect(tray.getByTestId("tray-popover")).toBeVisible()
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
      executablePath: packagedBinary ?? electronPath,
      args: appArgs,
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
    await expect
      .poll(() => app?.windows().some((page) => page.url().includes("index.html")))
      .toBe(true)
    const window = app.windows().find((page) => page.url().includes("index.html"))
    if (!window) throw new Error("Main app window did not open")
    await expect(window.getByTestId("app-ready")).toBeVisible()
    await window.getByTestId("project-item").click()
    await window.getByTestId("central-add-menu").click()
    await window.getByTestId("central-add-agent").click()
    const chooser = window.getByTestId("new-agent-dialog")
    await chooser.locator("label", { hasText: "Test Activity" }).click()
    await chooser.getByRole("button", { name: "Start agent" }).click()
    await expect(window.getByTestId("terminal")).toContainText("AGENT-ACTIVE")

    await expect
      .poll(() => app?.windows().some((page) => page.url().includes("tray.html")))
      .toBe(true)
    const tray = app.windows().find((page) => page.url().includes("tray.html"))
    if (!tray) throw new Error("Tray not created while project is open")
    await window.evaluate(() => window.close())
    const project = tray.getByRole("button", { name: /repo.*Working/ })
    await expect(project).toBeVisible()
    await expect(project.locator(".tray-project-dot")).toHaveCSS(
      "animation-name",
      "tray-agent-pulse",
    )
    await tray.emulateMedia({ reducedMotion: "reduce" })
    await expect(project.locator(".tray-project-dot")).toHaveCSS("animation-name", "none")
    const opened = app.waitForEvent("window", {
      predicate: (next) => next !== window && next !== tray,
    })
    await project.locator(".tray-project-state").click()
    const full = await opened
    await expect(full.getByTestId("project-view")).toBeVisible()
    await full.getByTestId("agent-status-control").click()
    const status = full.getByTestId("agent-status-panel")
    const session = status.getByRole("listitem").filter({ hasText: "repo" })
    await expect(session.locator("strong")).toHaveText("repo")
    await expect(session.locator("small")).toHaveText("test-activity")
    await expect(session).toContainText("Working")
    expect(
      await session.evaluate((row) => {
        const primary = row.querySelector("strong")
        const secondary = row.querySelector("small")
        if (!primary || !secondary) return false
        return (
          Number.parseFloat(getComputedStyle(primary).fontSize) >
          Number.parseFloat(getComputedStyle(secondary).fontSize)
        )
      }),
    ).toBe(true)
  } finally {
    // This test owns the live fixture agent; approve its normal quit-time cleanup.
    await app?.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    })
    await app?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

/** Exercise the native Dashboard action while an existing renderer owns unsaved text. */
test("tray Dashboard navigation preserves the existing renderer and unsaved draft", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-tray-draft-"))
  const repo = join(dir, "repo")
  let app: ElectronApplication | null = null
  try {
    await execFileAsync("git", ["init", "-b", "main", repo])
    await writeFile(join(repo, "README.md"), "# Original\n")
    app = await electron.launch({
      executablePath: packagedBinary ?? electronPath,
      args: appArgs,
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_TEST_OPEN_PROJECT: repo,
        PI_LAB_DATA_DIR: join(dir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dir, "daemon.sock"),
      },
    })
    const page = await app.firstWindow()
    await expect(page.getByTestId("app-ready")).toBeVisible()
    await page.getByTestId("nav-settings").click()
    await page.getByTestId("settings-restore-project-tabs").click()
    await expect(page.getByTestId("settings-restore-project-tabs")).toHaveAttribute(
      "aria-checked",
      "false",
    )
    await page.getByTestId("settings-back").click()
    await page.getByTestId("project-card").click()
    await page.getByTestId("panel-tab-files").click()
    await page.getByTestId("file-tree-file").click({ timeout: 5000 })
    const editor = page.locator(".cm-content").first()
    await editor.fill("# Unsaved tray draft")
    await expect(page.getByTestId("central-tab-dirty")).toBeVisible()
    await page.evaluate(() => {
      Reflect.set(window, "trayRendererIdentity", "original-renderer")
    })
    await page.evaluate(() => window.piLab?.backgroundTray?.openDashboard())
    await expect(page.getByTestId("dashboard")).toBeVisible()
    expect(await page.evaluate(() => Reflect.get(window, "trayRendererIdentity"))).toBe(
      "original-renderer",
    )
    await page.getByTestId("project-card").click()
    await expect(page.getByTestId("editor-buffer")).toContainText("Unsaved tray draft")
  } finally {
    await app?.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy()
    })
    await app?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

/** Inject only the activity snapshot; wheel routing uses the real tray renderer and CSS. */
test("tray project list scrolls from its padding when more than six projects are active", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-tray-scroll-"))
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: packagedBinary ?? electronPath,
      args: [...appArgs, "--pi-lab-background"],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_TEST_SHOW_TRAY: "1",
        PI_LAB_DATA_DIR: join(dir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dir, "daemon.sock"),
      },
    })
    const page = await app.firstWindow()
    await expect(page.getByTestId("tray-popover")).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => {
      const tray = BrowserWindow.getAllWindows()[0]
      tray.setSize(240, 273)
      tray.webContents.send("background-tray:changed", {
        projects: Array.from({ length: 12 }, (_, index) => ({
          id: `project-${index}`,
          name: `Project ${index}`,
          state: "working",
        })),
      })
    })
    await expect(page.locator(".tray-project-row")).toHaveCount(12)
    const list = page.locator(".tray-projects")
    const bounds = await list.boundingBox()
    if (!bounds) throw new Error("Tray project list is not visible")
    await page.mouse.move(bounds.x + 2, bounds.y + 20)
    await page.mouse.wheel(0, 200)
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  } finally {
    await app?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

/** Seed durable timestamps, then exercise the real runtime query and visible popup refresh. */
test("tray lists recently opened or agent-active projects without inactive dots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-tray-recent-"))
  const oldRepo = join(dir, "old-project")
  await execFileAsync("git", ["init", "-b", "main", oldRepo])
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: packagedBinary ?? electronPath,
      args: [...appArgs, "--pi-lab-background"],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_TEST_SHOW_TRAY: "1",
        PI_LAB_DATA_DIR: join(dir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dir, "daemon.sock"),
      },
    })
    const tray = await app.firstWindow()
    await expect(tray.getByText("PI Lab", { exact: true })).toBeVisible()
    const now = Date.now()
    const old = now - 8 * 86400000
    await execFileAsync("/usr/bin/sqlite3", [
      join(dir, "app-data", "local.db"),
      `
      INSERT INTO projects(id,repo_path,name,last_opened_at,created_at,updated_at) VALUES
      ('opened','/fixture/opened','Opened recently',${now},${old},${old}),
      ('agent','/fixture/agent','Agent recently',${old},${old},${old}),
      ('workflow','/fixture/workflow','Workflow recently',${old},${old},${old}),
      ('routine','/fixture/routine','Routine recently',${old},${old},${old}),
      ('11111111-1111-4111-8111-111111111111','${oldRepo}','Old project',${old},${old},${old});
      INSERT INTO agent_sessions(id,session_id,project_id,agent_id,state,created_at,updated_at)
      VALUES ('session','exited-fixture','agent','test','exited',${old},${now});
      INSERT INTO project_workflow_runs(id,project_id,task,last_checked_at,updated_at)
      VALUES ('workflow-run','workflow','summary',${now},${now});
      INSERT INTO automations(id,project_id,name,agent_id,execution_mode,recurrence_rule,start_at,timezone,enabled,created_at,updated_at)
      VALUES ('routine','routine','Fixture routine','test','noninteractive','FREQ=DAILY',${old},'UTC',0,${old},${old});
      INSERT INTO automation_runs(id,automation_id,scheduled_for,state,created_at,launched_at,completed_at)
      VALUES ('routine-run','routine',${old},'completed',${old},${old},${now});
      INSERT INTO automation_runs(id,automation_id,scheduled_for,state,created_at,launched_at)
      VALUES ('stale-running','routine',${old - 1},'running',${old},${old});
    `,
    ])
    await expect(tray.locator(".tray-project-row")).toHaveCount(4)
    for (const name of [
      "Opened recently",
      "Agent recently",
      "Workflow recently",
      "Routine recently",
    ]) {
      const row = tray.getByRole("button", { name, exact: true })
      await expect(row).toBeVisible()
      await expect(row.locator(".tray-project-dot")).toHaveCount(0)
    }
    await expect(tray.getByText("Old project", { exact: true })).toHaveCount(0)
    const fullWindow = app.waitForEvent("window", { predicate: (page) => page !== tray })
    await tray.locator(".tray-heading").click()
    const full = await fullWindow
    await expect(full.getByTestId("app-ready")).toBeVisible()
    await full.getByTestId("project-card").filter({ hasText: "Old project" }).click()
    await expect(full.getByTestId("project-view")).toBeVisible()
    await full.close()
    await expect(tray.getByRole("button", { name: "Old project", exact: true })).toBeVisible()
  } finally {
    await app?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

/** Regular macOS activation policy, with the real popover show path after closing. */
test("opening the tray under regular macOS activation does not reopen the full app", async () => {
  test.skip(process.platform !== "darwin", "macOS app activation")
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-tray-activation-"))
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: packagedBinary ?? electronPath,
      args: appArgs,
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_TEST_HIDE_WINDOWS: "0",
        PI_LAB_TEST_SHOW_TRAY: "1",
        PI_LAB_DATA_DIR: join(dir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dir, "daemon.sock"),
      },
    })
    await expect
      .poll(() =>
        app
          ?.windows()
          .some((page) => !page.url().includes("tray.html") && page.url() !== "about:blank"),
      )
      .toBe(true)
    const full = app
      .windows()
      .find((page) => !page.url().includes("tray.html") && page.url() !== "about:blank")
    if (!full) throw new Error("Full window missing")
    await expect(full.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(() => app?.windows().some((page) => page.url().includes("tray.html")))
      .toBe(true)
    await app.evaluate(({ app, BrowserWindow }) => {
      app.setActivationPolicy("regular")
      for (const window of BrowserWindow.getAllWindows()) window.hide()
      app.hide()
    })
    const frontmost = async () =>
      Number(
        (
          await execFileAsync("osascript", [
            "-l",
            "JavaScript",
            "-e",
            'ObjC.import("AppKit"); String($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier)',
          ])
        ).stdout.trim(),
      )
    await expect.poll(frontmost).not.toBe(app.process().pid)
    const previousApp = await frontmost()
    await full.close()
    const tray = app.windows().find((page) => page.url().includes("tray.html"))
    if (!tray) throw new Error("Tray missing")
    await expect(tray.getByTestId("tray-popover")).toBeVisible()
    // Give native application activation a turn to deliver its events.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await frontmost()).toBe(previousApp)
    expect(
      await app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().filter(
            (window) => !window.webContents.getURL().includes("tray.html"),
          ).length,
      ),
    ).toBe(0)
    const opened = app.waitForEvent("window", { predicate: (page) => page !== tray })
    await tray.locator(".tray-heading").click()
    await expect((await opened).getByTestId("app-ready")).toBeVisible()
    // Reopen the same native panel with the full window visible behind another app.
    await app.evaluate(({ app }) => app.hide())
    await expect.poll(frontmost).not.toBe(app.process().pid)
    const foregroundBeforePopup = await frontmost()
    await app.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows()
      const panel = windows.find((window) => window.webContents.getURL().includes("tray.html"))
      const main = windows.find((window) => !window.webContents.getURL().includes("tray.html"))
      if (!panel || !main) throw new Error("Expected main window and tray panel")
      main.showInactive()
      panel.show()
      panel.focus()
    })
    expect(await frontmost()).toBe(foregroundBeforePopup)
  } finally {
    await app?.close()
    await rm(dir, { recursive: true, force: true })
  }
})
