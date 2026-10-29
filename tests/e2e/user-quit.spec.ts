import { execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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
  test,
} from "./fixtures/playwright"

const execFileAsync = promisify(execFile)
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "desktop")
const electronPath = createRequire(join(desktop, "package.json"))("electron") as string
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Playwright launches outside Turbo.
const packagedBinary = process.env.PI_LAB_PACKAGED_BINARY
const launchArgs = packagedBinary ? [] : [join(desktop, "out/main/index.js")]

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

/** Native dialog choices are injected; the app, daemon, and terminal shell are real. */
test("explicit Quit names a busy terminal, Cancel keeps it, and Quit with idle shells ends the daemon", async () => {
  test.skip(process.platform === "win32", "Fixture uses POSIX shell and process listing")
  test.setTimeout(90_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-quit-shell-"))
  const repoDir = join(dataDir, "repo")
  const socketPath = join(dataDir, "daemon.sock")
  const client = new DaemonClient(socketPath)
  let app: ElectronApplication | null = null
  try {
    await execFileAsync("git", ["init", "-b", "main", repoDir])
    await writeFile(join(repoDir, "notes.md"), "# Quit fixture\n")
    app = await electron.launch({
      executablePath: packagedBinary ?? electronPath,
      args: launchArgs,
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_TEST_FIRST_RUN: "1",
        PI_LAB_TEST_RETAIN_DAEMON: "1",
        PI_LAB_DATA_DIR: dataDir,
        PI_LAB_SOCKET_PATH: socketPath,
        PI_LAB_TEST_OPEN_PROJECT: repoDir,
      },
    })
    app.on("close", () => {
      app = null
    })
    const window = await app.firstWindow()
    await window.getByRole("button", { name: "Skip setup" }).first().click()
    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await window.getByTestId("project-item").click()
    await window.getByTestId("central-add-menu").click()
    await window.getByTestId("central-add-terminal").click()
    const terminal = window.locator('[data-testid="terminal"]:visible')
    await expect.poll(() => existsSync(socketPath)).toBe(true)
    await client.connect()
    await expect
      .poll(async () => (await client.list()).filter((session) => session.alive).length)
      .toBe(1)
    let shell = (await client.list()).find((session) => session.alive)
    if (!shell?.pid) throw new Error("Terminal shell not running")
    const shellId = shell.id
    const foreground = async () =>
      (await client.list()).find((session) => session.id === shellId)?.foregroundProcess
    await terminal.locator(".xterm-helper-textarea").focus()
    await window.keyboard.insertText("sleep 100")
    await window.keyboard.press("Enter")
    await expect.poll(foreground, { timeout: 15_000 }).toBe("sleep")
    await app.evaluate(({ dialog }) => {
      const state = globalThis as unknown as { quitChoices: number[]; quitPrompts: string[] }
      state.quitChoices = []
      state.quitPrompts = []
      dialog.showMessageBox = async (options) => {
        state.quitPrompts.push(JSON.stringify(options))
        // An unexpected extra dialog gets 2: Cancel on the running-work confirmation.
        return { response: state.quitChoices.shift() ?? 2, checkboxChecked: false }
      }
    })
    const requestQuit = async (choice: number[]): Promise<void> => {
      if (!app) throw new Error("App already quit")
      await app.evaluate(({ Menu }, response) => {
        ;(globalThis as unknown as { quitChoices: number[] }).quitChoices = response
        const item = Menu.getApplicationMenu()?.getMenuItemById("user-quit")
        if (!item) throw new Error("Missing Quit menu item")
        setImmediate(() => item.click())
      }, choice)
    }
    const prompts = async () =>
      (await app?.evaluate(
        () => (globalThis as unknown as { quitPrompts: string[] }).quitPrompts,
      )) ?? []
    // Quit, then Cancel on the running-work confirmation.
    await requestQuit([2, 2])
    await expect.poll(async () => (await prompts()).length).toBe(2)
    const busy = JSON.parse((await prompts())[1] ?? "{}")
    expect(busy.message).toBe("1 terminal is still running a command.")
    expect(busy.detail).toContain("repo: sleep")
    expect(busy.buttons).toEqual([
      "Quit and stop terminals",
      "Keep running in background",
      "Cancel",
    ])
    expect(await foreground()).toBe("sleep")
    // Back at the prompt, the shell is idle: Quit needs only the first choice.
    await window.keyboard.press("Control+C")
    await expect.poll(foreground).not.toBe("sleep")
    shell = (await client.list()).find((session) => session.id === shellId)
    const daemonPid = await daemonPidFor(socketPath)
    expect(daemonPid).toBeGreaterThan(0)
    const closed = new Promise((resolve) => app?.once("close", resolve))
    // A second (running-work) dialog would get Cancel and the app would not close.
    await requestQuit([2])
    await closed
    await expect.poll(() => daemonPidFor(socketPath)).toBeUndefined()
    expect(alive(shell?.pid as number)).toBe(false)
    expect(existsSync(socketPath)).toBe(false)
  } finally {
    if (app) {
      const closed = (app as ElectronApplication).waitForEvent("close")
      ;(app as ElectronApplication).process().kill("SIGKILL")
      await closed
    }
    client.close()
    const daemonPid = await daemonPidFor(socketPath)
    if (daemonPid) process.kill(daemonPid, "SIGTERM")
    await rm(dataDir, { recursive: true, force: true })
  }
})

/** The app is real; the adopted daemon is a stand-in for one from an earlier build. */
test("explicit Quit stops an adopted daemon from an earlier build that ignores shutdown", async () => {
  test.skip(process.platform === "win32", "Fixture uses a Unix socket and process listing")
  test.setTimeout(60_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-old-daemon-"))
  const socketPath = join(dataDir, "daemon.sock")
  const entry = join(dataDir, "old build", "pty-daemon", "index.js")
  await mkdir(dirname(entry), { recursive: true })
  // Answers list requests like an old daemon and ignores the newer shutdown request.
  await writeFile(
    entry,
    `const net = require("node:net")
net.createServer((socket) => {
  let buffer = ""
  socket.on("data", (chunk) => {
    buffer += chunk
    let end
    while ((end = buffer.indexOf("\\n")) >= 0) {
      const frame = JSON.parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      if (frame.kind === "list") socket.write(JSON.stringify({ kind: "list-ok", cid: frame.cid, sessions: [] }) + "\\n")
      if (frame.kind === "process-list") socket.write(JSON.stringify({ kind: "process-list-ok", cid: frame.cid, processes: [] }) + "\\n")
    }
  })
}).listen(process.argv[2])
`,
  )
  const old = spawn(process.execPath, [entry, socketPath], { stdio: "ignore" })
  const oldExited = new Promise((resolve) => old.once("exit", resolve))
  let app: ElectronApplication | null = null
  try {
    await expect.poll(() => existsSync(socketPath)).toBe(true)
    app = await electron.launch({
      executablePath: packagedBinary ?? electronPath,
      args: launchArgs,
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_TEST_RETAIN_DAEMON: "1",
        PI_LAB_DATA_DIR: dataDir,
        PI_LAB_SOCKET_PATH: socketPath,
      },
    })
    app.on("close", () => {
      app = null
    })
    const window = await app.firstWindow()
    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false })
    })
    const closed = new Promise((resolve) => app?.once("close", resolve))
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("user-quit")
      if (!item) throw new Error("Missing Quit menu item")
      setImmediate(() => item.click())
    })
    await closed
    await oldExited
    expect(old.signalCode).toBe("SIGTERM")
  } finally {
    if (app) {
      const closed = (app as ElectronApplication).waitForEvent("close")
      ;(app as ElectronApplication).process().kill("SIGKILL")
      await closed
    }
    old.kill("SIGKILL")
    await rm(dataDir, { recursive: true, force: true })
  }
})

/** Native dialog choices are injected; the app, window close, daemon and shell are real. */
test("closing the window with Keep running after window closes off runs the Quit flow", async () => {
  test.skip(process.platform !== "darwin", "Background choice uses macOS app hiding")
  test.setTimeout(90_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-close-quit-"))
  const repoDir = join(dataDir, "repo")
  const socketPath = join(dataDir, "daemon.sock")
  const client = new DaemonClient(socketPath)
  let app: ElectronApplication | null = null
  try {
    await execFileAsync("git", ["init", "-b", "main", repoDir])
    await writeFile(join(repoDir, "notes.md"), "# Close fixture\n")
    app = await electron.launch({
      executablePath: packagedBinary ?? electronPath,
      args: launchArgs,
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_TEST_FIRST_RUN: "1",
        PI_LAB_TEST_RETAIN_DAEMON: "1",
        PI_LAB_DATA_DIR: dataDir,
        PI_LAB_SOCKET_PATH: socketPath,
        PI_LAB_TEST_OPEN_PROJECT: repoDir,
      },
    })
    app.on("close", () => {
      app = null
    })
    const window = await app.firstWindow()
    await window.getByRole("button", { name: "Skip setup" }).first().click()
    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await window.getByTestId("nav-settings").click()
    const keepRunning = window.getByTestId("settings-keep-running-after-close")
    await keepRunning.click()
    await expect(keepRunning).toHaveAttribute("aria-checked", "false")
    await window.getByTestId("settings-back").click()
    await window.getByTestId("project-item").click()
    await window.getByTestId("central-add-menu").click()
    await window.getByTestId("central-add-terminal").click()
    await expect.poll(() => existsSync(socketPath)).toBe(true)
    await client.connect()
    await expect
      .poll(async () => (await client.list()).filter((session) => session.alive).length)
      .toBe(1)
    const shell = (await client.list()).find((session) => session.alive)
    if (!shell?.pid) throw new Error("Terminal shell not running")
    await app.evaluate(({ dialog }) => {
      const state = globalThis as unknown as { quitChoices: number[]; quitPrompts: string[] }
      state.quitChoices = []
      state.quitPrompts = []
      dialog.showMessageBox = async (options) => {
        state.quitPrompts.push(JSON.stringify(options))
        return { response: state.quitChoices.shift() ?? 0, checkboxChecked: false }
      }
    })
    const closeWindow = async (choice: number[]): Promise<void> => {
      if (!app) throw new Error("App already quit")
      await app.evaluate(({ BrowserWindow }, response) => {
        ;(globalThis as unknown as { quitChoices: number[] }).quitChoices = response
        const [target] = BrowserWindow.getAllWindows()
        if (!target) throw new Error("No window")
        setImmediate(() => target.close())
      }, choice)
    }
    const prompts = async () =>
      (await app?.evaluate(
        () => (globalThis as unknown as { quitPrompts: string[] }).quitPrompts,
      )) ?? []
    // Cancel keeps the window open and the shell running.
    await closeWindow([0])
    await expect.poll(async () => (await prompts()).length).toBe(1)
    expect(JSON.parse((await prompts())[0] ?? "{}").buttons).toEqual([
      "Cancel",
      "Move to background",
      "Quit",
    ])
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((open) => open.isVisible()),
      ),
    ).toEqual([true])
    expect(alive(shell.pid)).toBe(true)
    // Quit with only an idle shell ends the shell, the daemon and the app.
    const daemonPid = await daemonPidFor(socketPath)
    expect(daemonPid).toBeGreaterThan(0)
    const closed = new Promise((resolve) => app?.once("close", resolve))
    await closeWindow([2])
    await closed
    await expect.poll(() => daemonPidFor(socketPath)).toBeUndefined()
    expect(alive(shell.pid)).toBe(false)
  } finally {
    if (app) {
      const closed = (app as ElectronApplication).waitForEvent("close")
      ;(app as ElectronApplication).process().kill("SIGKILL")
      await closed
    }
    client.close()
    const daemonPid = await daemonPidFor(socketPath)
    if (daemonPid) process.kill(daemonPid, "SIGTERM")
    await rm(dataDir, { recursive: true, force: true })
  }
})

/** Native dialog choices are injected; the app and managed agent process are real. */
test("two-step Quit confirms terminal and fetching work; either background choice and either Cancel preserve them", async () => {
  test.skip(process.platform !== "darwin", "Cmd+Q background assertions use macOS app visibility")
  test.setTimeout(90_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-quit-"))
  const repoDir = join(dataDir, "repo")
  const socketPath = join(dataDir, "daemon.sock")
  const client = new DaemonClient(socketPath)
  let app: ElectronApplication | null = null
  try {
    await execFileAsync("git", ["init", "-b", "main", repoDir])
    await writeFile(join(repoDir, "notes.md"), "# Quit fixture\n")
    await execFileAsync("git", ["-C", repoDir, "add", "."])
    await execFileAsync("git", [
      "-C",
      repoDir,
      "-c",
      "user.name=PI Lab Test",
      "-c",
      "user.email=test@pi-lab.local",
      "commit",
      "-m",
      "fixture",
    ])
    app = await electron.launch({
      executablePath: packagedBinary ?? electronPath,
      args: launchArgs,
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_TEST_FIRST_RUN: "1",
        PI_LAB_TEST_RETAIN_DAEMON: "1",
        PI_LAB_DATA_DIR: dataDir,
        PI_LAB_SOCKET_PATH: socketPath,
        PI_LAB_TEST_OPEN_PROJECT: repoDir,
      },
    })
    app.on("close", () => {
      app = null
    })
    const window = await app.firstWindow()
    await window.getByRole("button", { name: "Skip setup" }).first().click()
    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await window.getByTestId("nav-settings").click()
    await window.getByTestId("settings-nav-agents").click()
    const executable = join(dataDir, "fixture-agent")
    await writeFile(executable, "#!/bin/sh\nwhile :; do sleep 0.2; done\n", { mode: 0o755 })
    await window.getByTestId("settings-agent-executable-claude-code").fill(executable)
    await window.getByTestId("settings-agent-executable-claude-code").blur()
    await window.getByTestId("settings-back").click()
    await window.getByTestId("project-item").click()
    await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
    await window.getByTestId("analysis-fetch-experiments").click()
    await expect(window.getByTestId("workflow-result-working")).toBeVisible()
    await window.getByTestId("workflow-result-close").click()
    await window.getByTestId("project-item").click()
    await window.getByTestId("central-add-menu").click()
    await window.getByTestId("central-add-agent").click()
    const chooser = window.getByTestId("new-agent-dialog")
    await chooser.getByLabel("Test Activity").locator("..").click()
    await chooser.getByRole("button", { name: "Start agent" }).click()
    await expect(window.locator('[data-testid="terminal"]:visible')).toContainText("AGENT-ACTIVE")
    await expect.poll(() => existsSync(socketPath)).toBe(true)
    await client.connect()
    const [agent] = (await client.list()).filter((session) => session.alive)
    if (!agent) throw new Error("Managed agent not running")
    await expect
      .poll(async () => (await client.listProcesses()).filter((job) => job.alive).length)
      .toBe(1)
    const shell = await client.spawn({ command: "/bin/cat", args: [] })
    await app.evaluate(({ dialog }) => {
      const state = globalThis as unknown as { quitChoices: number[]; quitPrompts: string[] }
      state.quitChoices = []
      state.quitPrompts = []
      dialog.showMessageBox = async (options) => {
        state.quitPrompts.push(JSON.stringify(options))
        return { response: state.quitChoices.shift() ?? 2, checkboxChecked: false }
      }
    })
    const requestQuit = async (choice: number[]): Promise<void> => {
      if (!app) throw new Error("App already quit")
      const found = await app.evaluate(({ Menu }, response) => {
        ;(globalThis as unknown as { quitChoices: number[] }).quitChoices = response
        const item = Menu.getApplicationMenu()?.getMenuItemById("user-quit")
        if (!item) return false
        setImmediate(() => item.click())
        return item.accelerator
      }, choice)
      expect(found).toBe("CommandOrControl+Q")
    }
    await requestQuit([0])
    await expect
      .poll(async () =>
        app?.evaluate(
          () => (globalThis as unknown as { quitPrompts: string[] }).quitPrompts.length,
        ),
      )
      .toBe(1)
    expect((await client.list()).find((session) => session.id === agent.id)?.alive).toBe(true)
    expect((await client.listProcesses()).filter((job) => job.alive)).toHaveLength(1)
    await requestQuit([1])
    await expect.poll(() => app?.evaluate(({ app }) => app.isHidden())).toBe(true)
    expect((await client.list()).find((session) => session.id === agent.id)?.alive).toBe(true)
    expect((await client.listProcesses()).filter((job) => job.alive)).toHaveLength(1)
    await app.evaluate(({ app }) => app.show())
    await expect.poll(() => app?.evaluate(({ app }) => app.isHidden())).toBe(false)
    await requestQuit([2, 1])
    await expect
      .poll(async () =>
        app?.evaluate(
          () => (globalThis as unknown as { quitPrompts: string[] }).quitPrompts.length,
        ),
      )
      .toBe(4)
    expect((await client.list()).find((session) => session.id === agent.id)?.alive).toBe(true)
    expect((await client.listProcesses()).filter((job) => job.alive)).toHaveLength(1)
    await expect.poll(() => app?.evaluate(({ app }) => app.isHidden())).toBe(true)
    await app.evaluate(({ app }) => app.show())
    await requestQuit([2, 2])
    await expect
      .poll(async () =>
        app?.evaluate(
          () => (globalThis as unknown as { quitPrompts: string[] }).quitPrompts.length,
        ),
      )
      .toBe(6)
    expect((await client.list()).find((session) => session.id === agent.id)?.alive).toBe(true)
    expect((await client.listProcesses()).filter((job) => job.alive)).toHaveLength(1)
    expect(await app.evaluate(({ app }) => app.isHidden())).toBe(false)
    const prompts = await app.evaluate(
      () => (globalThis as unknown as { quitPrompts: string[] }).quitPrompts,
    )
    expect(prompts).toHaveLength(6)
    expect(JSON.parse(prompts[0] ?? "{}").buttons).toEqual([
      "Cancel",
      "Move to background",
      "Quit and stop all agents",
    ])
    expect(prompts[0]).toContain("Move to background")
    expect(prompts[0]).toContain("Cancel")
    expect(prompts[3]).toContain("results fetching")
    expect(prompts[3]).toContain("Keep agents running in background")
    expect(prompts[3]).toContain(": cat")
    const daemonPid = await daemonPidFor(socketPath)
    expect(daemonPid).toBeGreaterThan(0)
    const closed = app.waitForEvent("close")
    await requestQuit([2, 0])
    await closed
    app = null
    // Explicit Quit also stops ordinary terminals and the daemon itself.
    await expect.poll(() => daemonPidFor(socketPath)).toBeUndefined()
    expect(alive(agent.pid as number)).toBe(false)
    expect(alive(shell.pid as number)).toBe(false)
  } finally {
    if (app) {
      const closed = app.waitForEvent("close")
      app.process().kill("SIGKILL")
      await closed
    }
    client.close()
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="])
    const daemon = stdout
      .split("\n")
      .find((line) => line.includes(`/pty-daemon/index.js ${socketPath}`))
    if (daemon) process.kill(Number(daemon.trim().split(/\s+/)[0]), "SIGTERM")
    await rm(dataDir, { recursive: true, force: true })
  }
})

/** The native dialog response is injected; draft handling uses the real renderer and IPC. */
test("idle explicit Quit always asks, Background preserves a draft, and draft cancellation allows another choice", async () => {
  test.skip(process.platform !== "darwin", "Background assertion uses macOS app visibility")
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-idle-user-quit-"))
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: packagedBinary ?? electronPath,
      args: launchArgs,
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: dataDir,
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      },
    })
    app.on("close", () => {
      app = null
    })
    const window = await app.firstWindow()
    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await app.evaluate(({ dialog }) => {
      const state = globalThis as unknown as { choice: number; prompts: number; buttons: string[] }
      state.prompts = 0
      state.choice = 2
      dialog.showMessageBox = async (options) => {
        state.buttons = options.buttons ?? []
        state.prompts++
        return { response: state.choice, checkboxChecked: false }
      }
    })
    const request = async (choice: number) => {
      await app?.evaluate(({ Menu }, response) => {
        ;(globalThis as unknown as { choice: number }).choice = response
        Menu.getApplicationMenu()?.getMenuItemById("user-quit")?.click()
      }, choice)
    }
    const count = () => app?.evaluate(() => (globalThis as unknown as { prompts: number }).prompts)
    await request(0)
    await expect.poll(count).toBe(1)
    expect(
      await app.evaluate(() => (globalThis as unknown as { buttons: string[] }).buttons),
    ).toEqual(["Cancel", "Move to background", "Quit"])
    await window.getByTestId("nav-editor").click()
    const editor = window.getByTestId("quick-editor-full-app").locator(".cm-content")
    await editor.fill("keep_this_draft = True\n")
    await window.getByTestId("nav-dashboard").click()
    await request(1)
    await expect.poll(() => app?.evaluate(({ app }) => app.isHidden())).toBe(true)
    await window.getByTestId("nav-editor").click()
    await expect(editor).toContainText("keep_this_draft = True")
    await window.getByTestId("nav-dashboard").click()
    await request(2)
    const recovery = window.getByRole("dialog", { name: "Unsaved changes" })
    await expect(recovery).toBeVisible()
    await request(2)
    expect(await count()).toBe(3)
    await recovery.getByRole("button", { name: "Cancel", exact: true }).click()
    await request(2)
    await expect.poll(count).toBe(4)
    await expect(recovery).toBeVisible()
    const closed = app.waitForEvent("close")
    await recovery.getByRole("button", { name: "Discard affected" }).click()
    await closed
    app = null
  } finally {
    if (app) {
      const closed = app.waitForEvent("close")
      app.process().kill("SIGKILL")
      await closed
    }
    await rm(dataDir, { recursive: true, force: true })
  }
})
