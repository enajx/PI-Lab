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
  test,
} from "./fixtures/playwright"
import { processAlive, readServerDiscovery } from "./fixtures/serverClient"
import { stopServerIn } from "./fixtures/stopServer"

const execFileAsync = promisify(execFile)
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "desktop")
const electronPath = createRequire(join(desktop, "package.json"))("electron") as string

/** The pty-daemon process serving `socketPath`, if one is running. */
async function daemonPid(socketPath: string): Promise<number | undefined> {
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

/** Native dialog choices are injected; the app and managed agent process are real. */
test("a quit PI Lab did not start (like macOS logout) warns while work runs, then quits the app; the server keeps the work running", async () => {
  test.skip(process.platform === "win32", "Fixture uses POSIX shell and process listing")
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
      executablePath: electronPath,
      args: [join(desktop, "out", "main", "index.js")],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_TEST_FIRST_RUN: "1",
        PI_LAB_TEST_RETAIN_SERVER: "1",
        PI_LAB_TEST_RETAIN_DAEMON: "1",
        PI_LAB_DATA_DIR: dataDir,
        PI_LAB_SOCKET_PATH: socketPath,
        PI_LAB_TEST_OPEN_PROJECT: repoDir,
      },
    })
    const window = await app.firstWindow()
    await window.getByRole("button", { name: "Skip setup" }).first().click()
    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
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
    const shell = await client.spawn({ command: "/bin/cat", args: [] })
    await app.evaluate(({ dialog }) => {
      const state = globalThis as typeof globalThis & { e2eDialogs?: string[]; e2eAnswer?: number }
      state.e2eDialogs = []
      state.e2eAnswer = 1
      dialog.showMessageBox = async (...args: unknown[]) => {
        const options = args.at(-1) as { message: string; buttons: string[] }
        state.e2eDialogs?.push(`${options.message} | ${options.buttons.join(", ")}`)
        return { response: state.e2eAnswer ?? 1, checkboxChecked: false }
      }
    })
    const serverPid = readServerDiscovery(dataDir)?.pid ?? 0
    expect(processAlive(serverPid)).toBe(true)
    // macOS logout, restart and shutdown reach the app as this same app.quit().
    // They also end the user's server, so the app warns while work runs; Cancel keeps it open.
    await app.evaluate(({ app }) => {
      setImmediate(() => app.quit())
    })
    await expect
      .poll(() => app?.evaluate(() => (globalThis as { e2eDialogs?: string[] }).e2eDialogs ?? []))
      .toEqual([expect.stringMatching(/still running.*\| Quit, Cancel$/)])
    expect(app.process().exitCode).toBeNull()
    const closed = app.waitForEvent("close")
    await app.evaluate(({ app }) => {
      ;(globalThis as { e2eAnswer?: number }).e2eAnswer = 0
      setImmediate(() => app.quit())
    })
    await closed
    app = null
    // Without a real logout the server keeps the work running.
    expect(processAlive(serverPid)).toBe(true)
    expect((await client.list()).find((session) => session.id === agent.id)?.alive).toBe(true)
    expect(alive(shell.pid as number)).toBe(true)
    // Stopping the server stops the agent, the terminal and the daemon.
    await stopServerIn(dataDir)
    await expect.poll(() => daemonPid(socketPath)).toBeUndefined()
    expect(alive(agent.pid as number)).toBe(false)
    expect(alive(shell.pid as number)).toBe(false)
  } finally {
    if (app) {
      const closed = app.waitForEvent("close")
      app.process().kill("SIGKILL")
      await closed
    }
    client.close()
    await stopServerIn(dataDir)
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="])
    const daemon = stdout
      .split("\n")
      .find((line) => line.includes(`/pty-daemon/index.js ${socketPath}`))
    if (daemon) process.kill(Number(daemon.trim().split(/\s+/)[0]), "SIGTERM")
    await rm(dataDir, { recursive: true, force: true })
  }
})

/** A local executable fixture crosses the real workflow IPC and daemon process boundaries. */
test("background summary survives Restart to Update, restores its result, and a later quit leaves it running until the server is stopped", async () => {
  test.skip(process.platform === "win32", "Fixture executable is a POSIX shell script")
  test.setTimeout(90_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-background-agent-"))
  const repoDir = join(dataDir, "repo")
  const socketPath = join(dataDir, "daemon.sock")
  const client = new DaemonClient(socketPath)
  const release = join(dataDir, "release")
  const executable = join(dataDir, "fixture-agent")
  let app: ElectronApplication | null = null
  const launch = (): Promise<ElectronApplication> =>
    electron.launch({
      executablePath: electronPath,
      args: [join(desktop, "out", "main", "index.js")],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_TEST_RETAIN_SERVER: "1",
        PI_LAB_TEST_RETAIN_DAEMON: "1",
        PI_LAB_DATA_DIR: dataDir,
        PI_LAB_SOCKET_PATH: socketPath,
        PI_LAB_TEST_OPEN_PROJECT: repoDir,
      },
    })
  try {
    await execFileAsync("git", ["init", "-b", "main", repoDir])
    await writeFile(join(repoDir, "notes.md"), "# Background fixture\n")
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
    await writeFile(
      executable,
      `#!/bin/sh
while [ ! -f '${release}' ]; do sleep 0.1; done
printf '{"type":"result","result":"BACKGROUND-RECOVERED","is_error":false}\\n'
`,
      { mode: 0o755 },
    )
    app = await launch()
    let window = await app.firstWindow()
    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await window.getByTestId("nav-settings").click()
    await window.getByTestId("settings-nav-agents").click()
    const executableInput = window.getByTestId("settings-agent-executable-claude-code")
    await executableInput.fill(executable)
    await executableInput.blur()
    await window.getByTestId("settings-back").click()
    await window.getByTestId("project-card-status-button").click()
    await window.getByTestId("project-status-update-summary").click()
    await expect(window.getByTestId("workflow-result-working")).toBeVisible()
    await expect.poll(() => existsSync(socketPath)).toBe(true)
    await client.connect()
    await expect
      .poll(async () => (await client.listProcesses()).filter((job) => job.alive).length)
      .toBe(1)
    const original = (await client.listProcesses()).find((job) => job.alive)
    if (!original) throw new Error("Background routine not running")
    const closed = app.waitForEvent("close")
    await app.evaluate(() => {
      const hook = (globalThis as { piLabTestRestartToUpdate?: () => void })
        .piLabTestRestartToUpdate
      if (!hook) throw new Error("Missing Restart to Update test seam")
      setImmediate(hook)
    })
    await closed
    app = null
    expect((await client.listProcesses()).find((job) => job.id === original.id)?.alive).toBe(true)
    await writeFile(release, "finish")
    // The server finishes the routine with no client connected, then drops the finished job.
    await expect
      .poll(
        async () =>
          (await client.listProcesses()).find((job) => job.id === original.id)?.alive ?? false,
      )
      .toBe(false)
    app = await launch()
    window = await app.firstWindow()
    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await window.getByTestId("project-card-status-button").click()
    await window.getByTestId("project-status-update-summary").click()
    await expect(window.getByTestId("workflow-result-text")).toContainText("BACKGROUND-RECOVERED")
    await expect.poll(async () => (await client.listProcesses()).length).toBe(0)
    await window.getByTestId("workflow-result-close").click()
    await rm(release)
    // The Project status card stays open under the closed run window.
    await window.getByTestId("project-status-update-summary").click()
    await window.getByTestId("workflow-result-recheck").click()
    await expect
      .poll(async () => (await client.listProcesses()).filter((job) => job.alive).length)
      .toBe(1)
    const stopped = app.waitForEvent("close")
    await app.evaluate(({ app }) => {
      setImmediate(() => app.quit())
    })
    await stopped
    app = null
    // A plain quit leaves the routine running on the server.
    expect((await client.listProcesses()).filter((job) => job.alive)).toHaveLength(1)
    await stopServerIn(dataDir)
    await expect.poll(() => daemonPid(socketPath)).toBeUndefined()
  } finally {
    if (app) {
      const closed = app.waitForEvent("close")
      app.process().kill("SIGKILL")
      await closed
    }
    client.close()
    await stopServerIn(dataDir)
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="])
    const daemon = stdout
      .split("\n")
      .find((line) => line.includes(`/pty-daemon/index.js ${socketPath}`))
    if (daemon) process.kill(Number(daemon.trim().split(/\s+/)[0]), "SIGTERM")
    await rm(dataDir, { recursive: true, force: true })
  }
})
