import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { DaemonClient } from "../../packages/pty-daemon/src/index"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "./fixtures/playwright"

/**
 * The real native Quit dialogs, read and clicked through macOS Accessibility
 * (System Events via `osascript`). The app runs with
 * `PI_LAB_TEST_NATIVE_DIALOGS=1`, so no test responder answers the dialogs.
 * The windows and dialogs must be on screen, and the terminal app running the
 * tests needs Accessibility permission.
 */

const execFileAsync = promisify(execFile)
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "desktop")
const electronPath = createRequire(join(desktop, "package.json"))("electron") as string

const PERMISSION_HELP =
  "macOS Accessibility permission is missing. Grant Accessibility to the terminal app running the tests " +
  "(System Settings → Privacy & Security → Accessibility), then run this spec again."

/**
 * Lists the windows of process `pid` with their static texts and direct buttons,
 * as lines "WINDOW", "TEXT:<value>", "BUTTON:<name>".
 */
const LIST_SCRIPT = `on run argv
  set pidValue to (item 1 of argv) as integer
  set output to ""
  tell application "System Events"
    set proc to first process whose unix id is pidValue
    repeat with w in windows of proc
      set output to output & "WINDOW" & linefeed
      repeat with t in static texts of w
        set output to output & "TEXT:" & (value of t as text) & linefeed
      end repeat
      repeat with b in buttons of w
        set output to output & "BUTTON:" & (name of b as text) & linefeed
      end repeat
    end repeat
  end tell
  return output
end run`

/** Clicks the button named argv[2] in the first window of process argv[1] that has it. */
const CLICK_SCRIPT = `on run argv
  set pidValue to (item 1 of argv) as integer
  set target to item 2 of argv
  tell application "System Events"
    set proc to first process whose unix id is pidValue
    repeat with w in windows of proc
      if (name of buttons of w) contains target then
        click (first button of w whose name is target)
        return "clicked"
      end if
    end repeat
  end tell
  error "No button named " & target
end run`

interface AxWindow {
  texts: string[]
  buttons: string[]
}

/** Runs an AppleScript; a missing Accessibility permission fails with {@link PERMISSION_HELP}. */
async function osascript(script: string, args: string[]): Promise<string> {
  const result = await execFileAsync("osascript", ["-e", script, ...args]).catch(
    (error: { stderr?: string; message: string }) => {
      const text = `${error.stderr ?? ""} ${error.message}`
      if (/-1719|-25211|assistive access/i.test(text)) throw new Error(PERMISSION_HELP)
      throw error
    },
  )
  return result.stdout
}

/** Windows of process `pid` as macOS Accessibility reports them. */
async function axWindows(pid: number): Promise<AxWindow[]> {
  const windows: AxWindow[] = []
  for (const line of (await osascript(LIST_SCRIPT, [String(pid)])).split("\n")) {
    if (line === "WINDOW") windows.push({ texts: [], buttons: [] })
    const current = windows.at(-1)
    if (!current) continue
    if (line.startsWith("TEXT:")) current.texts.push(line.slice(5))
    else if (line.startsWith("BUTTON:")) current.buttons.push(line.slice(7))
    else if (line !== "WINDOW" && current.texts.length > 0 && current.buttons.length === 0)
      // A multi-line text value continues on the following lines.
      current.texts[current.texts.length - 1] += `\n${line}`
  }
  return windows
}

/** Waits for a window of `pid` with a button named `button` and returns it. */
async function waitForDialog(pid: number, button: string): Promise<AxWindow> {
  let found: AxWindow | undefined
  await expect
    .poll(
      async () => {
        found = (await axWindows(pid)).find((window) => window.buttons.includes(button))
        return found !== undefined
      },
      { timeout: 15_000, message: `native dialog with a "${button}" button` },
    )
    .toBe(true)
  return found as AxWindow
}

/** Waits until no window of `pid` has a button named `button`. */
async function waitForDialogGone(pid: number, button: string): Promise<void> {
  await expect
    .poll(async () => (await axWindows(pid)).some((window) => window.buttons.includes(button)), {
      timeout: 10_000,
    })
    .toBe(false)
}

/** Clicks a native dialog button by name. */
async function click(pid: number, button: string): Promise<void> {
  await osascript(CLICK_SCRIPT, [String(pid), button])
}

/** The pty-daemon process serving `socketPath`, if one is running. */
async function daemonPidFor(socketPath: string): Promise<number | undefined> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="])
  const line = stdout
    .split("\n")
    .find((entry) => entry.includes(`/pty-daemon/index.js ${socketPath}`))
  return line ? Number(line.trim().split(/\s+/)[0]) : undefined
}

/** Whether a process exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

interface Fixture {
  app: ElectronApplication
  pid: number
  window: Page
  client: DaemonClient
  socketPath: string
  dataDir: string
  shellPid: number
  /** The foreground command of the test terminal. */
  foreground(): Promise<string | null | undefined>
}

/** Launches the app with real native dialogs and runs `sleep 100` in a terminal. */
async function launchWithBusyTerminal(prefix: string): Promise<Fixture> {
  const dataDir = await mkdtemp(join(tmpdir(), prefix))
  const repoDir = join(dataDir, "repo")
  const socketPath = join(dataDir, "daemon.sock")
  await execFileAsync("git", ["init", "-b", "main", repoDir])
  await writeFile(join(repoDir, "notes.md"), "# Quit fixture\n")
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PI_LAB_TEST_MODE: "1",
    PI_LAB_TEST_NATIVE_DIALOGS: "1",
    PI_LAB_TEST_FIRST_RUN: "1",
    PI_LAB_TEST_RETAIN_DAEMON: "1",
    PI_LAB_DATA_DIR: dataDir,
    PI_LAB_SOCKET_PATH: socketPath,
    PI_LAB_TEST_OPEN_PROJECT: repoDir,
  }
  // Accessibility needs the windows and dialogs on screen.
  delete env.PI_LAB_TEST_HIDE_WINDOWS
  const app = await electron.launch({
    executablePath: electronPath,
    args: [join(desktop, "out", "main", "index.js")],
    env,
  })
  const pid = app.process().pid
  if (!pid) throw new Error("Electron has no pid")
  const window = await app.firstWindow()
  await window.getByRole("button", { name: "Skip setup" }).first().click()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await window.getByTestId("central-add-menu").click()
  await window.getByTestId("central-add-terminal").click()
  const terminal = window.locator('[data-testid="terminal"]:visible')
  await expect.poll(() => existsSync(socketPath)).toBe(true)
  const client = new DaemonClient(socketPath)
  await client.connect()
  await expect
    .poll(async () => (await client.list()).filter((session) => session.alive).length)
    .toBe(1)
  const shell = (await client.list()).find((session) => session.alive)
  if (!shell?.pid) throw new Error("Terminal shell not running")
  const foreground = async () =>
    (await client.list()).find((session) => session.id === shell.id)?.foregroundProcess
  await terminal.locator(".xterm-helper-textarea").focus()
  await window.keyboard.insertText("sleep 100")
  await window.keyboard.press("Enter")
  await expect.poll(foreground, { timeout: 15_000 }).toBe("sleep")
  return { app, pid, window, client, socketPath, dataDir, shellPid: shell.pid, foreground }
}

/** Kills whatever the test left running and removes its data dir. */
async function cleanUp(fixture: Fixture | null, closed: boolean): Promise<void> {
  if (!fixture) return
  if (!closed && alive(fixture.pid)) {
    const exited = fixture.app.waitForEvent("close")
    fixture.app.process().kill("SIGKILL")
    await exited
  }
  fixture.client.close()
  const daemonPid = await daemonPidFor(fixture.socketPath)
  if (daemonPid) process.kill(daemonPid, "SIGTERM")
  await rm(fixture.dataDir, { recursive: true, force: true })
}

test.describe("native Quit dialogs (macOS Accessibility)", () => {
  test.skip(process.platform !== "darwin", "Reads native dialogs through macOS Accessibility")
  test.skip(
    !!process.env.CI,
    "Needs on-screen windows and Accessibility permission, not set up on CI",
  )

  test.beforeAll(async () => {
    // Fail before launching anything when the permission is missing.
    await osascript(
      'tell application "System Events" to get name of every window of (first process whose frontmost is true)',
      [],
    )
  })

  test("Quit with a busy terminal: Cancel keeps it running, Quit and stop terminals ends the app and daemon", async () => {
    test.setTimeout(120_000)
    let fixture: Fixture | null = null
    let closed = false
    try {
      fixture = await launchWithBusyTerminal("pi-lab-e2e-native-quit-")
      const { app, pid } = fixture
      app.once("close", () => {
        closed = true
      })
      const requestQuit = () =>
        app.evaluate(({ Menu }) => {
          const item = Menu.getApplicationMenu()?.getMenuItemById("user-quit")
          if (!item) throw new Error("Missing Quit menu item")
          setImmediate(() => item.click())
        })

      await requestQuit()
      const first = await waitForDialog(pid, "Quit")
      expect(first.buttons).toEqual(
        expect.arrayContaining(["Cancel", "Move to background", "Quit"]),
      )
      await click(pid, "Quit")
      const busy = await waitForDialog(pid, "Quit and stop terminals")
      expect(busy.texts).toContain("1 terminal is still running a command.")
      expect(busy.texts.join("\n")).toContain("repo: sleep")
      expect([...busy.buttons].sort()).toEqual(
        ["Cancel", "Keep running in background", "Quit and stop terminals"].sort(),
      )
      await click(pid, "Cancel")
      await waitForDialogGone(pid, "Quit and stop terminals")
      expect(closed).toBe(false)
      expect(alive(pid)).toBe(true)
      expect(await fixture.foreground()).toBe("sleep")

      const daemonPid = await daemonPidFor(fixture.socketPath)
      expect(daemonPid).toBeGreaterThan(0)
      const exited = app.waitForEvent("close")
      await requestQuit()
      await waitForDialog(pid, "Quit")
      await click(pid, "Quit")
      await waitForDialog(pid, "Quit and stop terminals")
      await click(pid, "Quit and stop terminals")
      await exited
      await expect.poll(() => daemonPidFor(fixture?.socketPath ?? "")).toBeUndefined()
      expect(alive(daemonPid as number)).toBe(false)
      expect(alive(fixture.shellPid)).toBe(false)
    } finally {
      await cleanUp(fixture, closed)
    }
  })

  test("a quit PI Lab did not start (like macOS logout) with a busy terminal: Cancel keeps it, Quit and stop ends it", async () => {
    test.setTimeout(120_000)
    let fixture: Fixture | null = null
    let closed = false
    try {
      fixture = await launchWithBusyTerminal("pi-lab-e2e-native-logout-")
      const { app, pid } = fixture
      app.once("close", () => {
        closed = true
      })
      // macOS logout, restart and shutdown reach the app as this same app.quit().
      const requestQuit = () =>
        app.evaluate(({ app }) => {
          setImmediate(() => app.quit())
        })

      await requestQuit()
      const dialog = await waitForDialog(pid, "Quit and stop terminals")
      expect(dialog.texts).toContain("1 terminal is still running a command.")
      expect(dialog.texts.join("\n")).toContain("repo: sleep")
      expect([...dialog.buttons].sort()).toEqual(["Cancel", "Quit and stop terminals"])
      await click(pid, "Cancel")
      await waitForDialogGone(pid, "Quit and stop terminals")
      expect(closed).toBe(false)
      expect(alive(pid)).toBe(true)
      expect(await fixture.foreground()).toBe("sleep")

      const daemonPid = await daemonPidFor(fixture.socketPath)
      expect(daemonPid).toBeGreaterThan(0)
      const exited = app.waitForEvent("close")
      await requestQuit()
      await waitForDialog(pid, "Quit and stop terminals")
      await click(pid, "Quit and stop terminals")
      await exited
      await expect.poll(() => daemonPidFor(fixture?.socketPath ?? "")).toBeUndefined()
      expect(alive(daemonPid as number)).toBe(false)
      expect(alive(fixture.shellPid)).toBe(false)
    } finally {
      await cleanUp(fixture, closed)
    }
  })
})
