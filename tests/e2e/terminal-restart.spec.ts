import { execFile } from "node:child_process"
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

/** Find only the daemon belonging to this test's unique socket, for final cleanup. */
async function daemonPidFor(socketPath: string): Promise<number | undefined> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="])
  const line = stdout
    .split("\n")
    .find((entry) => entry.includes(`/pty-daemon/index.js ${socketPath}`))
  return line ? Number(line.trim().split(/\s+/)[0]) : undefined
}

test("keep-running preserves the same agent terminal across a real app quit and restart", async () => {
  test.skip(process.platform === "win32", "Daemon cleanup uses the Unix process list")
  test.setTimeout(90_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-restart-"))
  const repoDir = join(dataDir, "repo")
  const socketPath = join(dataDir, "daemon.sock")
  const client = new DaemonClient(socketPath)
  let app: ElectronApplication | null = null
  let daemonPid: number | undefined

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
    await writeFile(join(repoDir, "notes.md"), "# Restart fixture\n")
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
    app = await launch()
    const window = await app.firstWindow()
    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await window.getByTestId("nav-settings").click()
    const restoreTabs = window.getByTestId("settings-restore-project-tabs")
    if ((await restoreTabs.getAttribute("aria-checked")) !== "true") await restoreTabs.click()
    await window.getByTestId("settings-nav-agents").click()
    const quitBehavior = window.getByTestId("settings-agent-quit-behavior")
    await quitBehavior.selectOption("keep-running", { timeout: 5_000 })
    await expect(quitBehavior).toHaveValue("keep-running")
    await window.getByTestId("settings-back").click()

    await window.getByTestId("project-item").click()
    await window.getByTestId("central-add-menu").click()
    await window.getByTestId("central-add-agent").click()
    const chooser = window.getByTestId("new-agent-dialog")
    await chooser.getByLabel("Test Activity").locator("..").click()
    await chooser.getByRole("button", { name: "Start agent" }).click()
    await expect(chooser).toBeHidden()
    await expect(window.locator('[data-testid="terminal"]:visible')).toContainText("AGENT-ACTIVE")
    daemonPid = await daemonPidFor(socketPath)
    expect(daemonPid).toBeDefined()
    await client.connect()
    const [original] = (await client.list()).filter((session) => session.alive)
    expect(original?.pid).toBeGreaterThan(0)
    if (!original) throw new Error("Agent terminal did not start")
    await client.attach(original.id)
    let outputEvents = 0
    client.on("data", (event) => {
      if (event.sessionId === original.id) outputEvents += 1
    })

    const closed = app.waitForEvent("close")
    await app.evaluate(({ app: electronApp }) => {
      setImmediate(() => electronApp.quit())
    })
    await closed
    app = null
    const eventsAfterQuit = outputEvents
    await expect.poll(() => outputEvents).toBeGreaterThan(eventsAfterQuit)
    expect((await client.list()).find((session) => session.id === original.id)).toMatchObject({
      pid: original.pid,
      alive: true,
    })

    app = await launch()
    const reopened = await app.firstWindow()
    await expect(reopened.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await reopened.getByTestId("project-item").click()
    const restoredTerminal = reopened.locator('[data-testid="terminal"]:visible')
    await expect(restoredTerminal).toContainText("AGENT-ACTIVE")
    // New PTY echo proves this is a live restored stream, not just old scrollback.
    await restoredTerminal.locator(".xterm-helper-textarea").focus()
    await reopened.keyboard.insertText("RESTART-PTY-ECHO")
    await expect(restoredTerminal).toContainText("RESTART-PTY-ECHO")
    const live = (await client.list()).filter((session) => session.alive)
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ id: original.id, pid: original.pid })
  } finally {
    await app?.close()
    daemonPid ??= await daemonPidFor(socketPath)
    if (daemonPid !== undefined && (await daemonPidFor(socketPath)) === daemonPid) {
      process.kill(daemonPid, "SIGTERM")
      await expect.poll(() => daemonPidFor(socketPath)).toBeUndefined()
    }
    client.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
