import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"
import { DaemonClient } from "../../packages/pty-daemon/src/index"

const execFileAsync = promisify(execFile)
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "desktop")
const electronPath = createRequire(join(desktop, "package.json"))("electron") as string

/** Native dialog choices are injected; the app and managed agent process are real. */
test("default quit policy cancels, opens Settings, then stops the agent while preserving ordinary shells", async () => {
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
        PI_LAB_TEST_RETAIN_DAEMON: "1",
        PI_LAB_DATA_DIR: dataDir,
        PI_LAB_SOCKET_PATH: socketPath,
        PI_LAB_TEST_OPEN_PROJECT: repoDir,
      },
    })
    const window = await app.firstWindow()
    await window.getByRole("button", { name: "Skip setup" }).first().click()
    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await window.getByTestId("nav-settings").click()
    await window.getByTestId("settings-nav-agents").click()
    await expect(window.getByTestId("settings-agent-quit-behavior")).toHaveValue("stop")
    await window.getByTestId("settings-back").click()
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
      const state = globalThis as unknown as { quitChoice: number; quitPrompts: string[] }
      state.quitChoice = 0
      state.quitPrompts = []
      dialog.showMessageBox = async (options) => {
        state.quitPrompts.push(JSON.stringify(options))
        return { response: state.quitChoice, checkboxChecked: false }
      }
    })
    const requestQuit = async (choice: number): Promise<void> => {
      if (!app) throw new Error("App already quit")
      await app.evaluate(({ app }, response) => {
        ;(globalThis as unknown as { quitChoice: number }).quitChoice = response
        setImmediate(() => app.quit())
      }, choice)
    }
    await requestQuit(0)
    await expect
      .poll(async () =>
        app?.evaluate(
          () => (globalThis as unknown as { quitPrompts: string[] }).quitPrompts.length,
        ),
      )
      .toBe(1)
    expect((await client.list()).find((session) => session.id === agent.id)?.alive).toBe(true)
    await requestQuit(2)
    await expect.poll(() => window.url()).toContain("#/settings?section=agents")
    // Test-only outer query parameters collide with TanStack's hash search parser.
    // Production file URLs have no such query; preserve the requested hash route.
    await window.evaluate(() => {
      history.replaceState(history.state, "", window.location.pathname + window.location.hash)
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    await expect(window.getByTestId("settings-agent-quit-behavior")).toBeVisible()
    await expect(window.getByTestId("settings-agent-quit-behavior")).toHaveValue("stop")
    expect((await client.list()).find((session) => session.id === agent.id)?.alive).toBe(true)
    const prompts = await app.evaluate(
      () => (globalThis as unknown as { quitPrompts: string[] }).quitPrompts,
    )
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain("stop agents when quitting")
    const closed = app.waitForEvent("close")
    await requestQuit(1)
    await closed
    app = null
    expect((await client.list()).find((session) => session.id === agent.id)?.alive).toBe(false)
    expect((await client.list()).find((session) => session.id === shell.id)?.alive).toBe(true)
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

/** A local executable fixture crosses the real workflow IPC and daemon process boundaries. */
test("background summary survives keep-running quit, restores its result, and stops under the default policy", async () => {
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
    await window.getByTestId("settings-agent-quit-behavior").selectOption("keep-running")
    await window.getByTestId("settings-back").click()
    await window.getByTestId("project-card-summary").click()
    await expect(window.getByTestId("workflow-result-working")).toBeVisible()
    await expect.poll(() => existsSync(socketPath)).toBe(true)
    await client.connect()
    await expect
      .poll(async () => (await client.listProcesses()).filter((job) => job.alive).length)
      .toBe(1)
    const original = (await client.listProcesses()).find((job) => job.alive)
    if (!original) throw new Error("Background routine not running")
    const closed = app.waitForEvent("close")
    await app.evaluate(({ app }) => {
      setImmediate(() => app.quit())
    })
    await closed
    app = null
    expect((await client.listProcesses()).find((job) => job.id === original.id)?.alive).toBe(true)
    await writeFile(release, "finish")
    await expect
      .poll(async () => (await client.listProcesses()).find((job) => job.id === original.id)?.alive)
      .toBe(false)
    app = await launch()
    window = await app.firstWindow()
    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await window.getByTestId("project-card-summary").click()
    await expect(window.getByTestId("workflow-result-text")).toContainText("BACKGROUND-RECOVERED")
    await expect.poll(async () => (await client.listProcesses()).length).toBe(0)
    await window.getByTestId("workflow-result-close").click()
    await window.getByTestId("nav-settings").click()
    await window.getByTestId("settings-nav-agents").click()
    await window.getByTestId("settings-agent-quit-behavior").selectOption("stop")
    await window.getByTestId("settings-back").click()
    await rm(release)
    await window.getByTestId("project-card-summary").click()
    await window.getByTestId("workflow-result-recheck").click()
    await expect
      .poll(async () => (await client.listProcesses()).filter((job) => job.alive).length)
      .toBe(1)
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    })
    const stopped = app.waitForEvent("close")
    await app.evaluate(({ app }) => {
      setImmediate(() => app.quit())
    })
    await stopped
    app = null
    expect(await client.listProcesses()).toEqual([])
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
