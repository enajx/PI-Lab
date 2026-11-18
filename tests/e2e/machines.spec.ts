import { type ChildProcess, execFile, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type SshTestServer, startSshTestServer } from "../support/sshTestServer"
import { headlessServerEnv, startHeadlessServer } from "./fixtures/headlessServer"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "./fixtures/playwright"
import { connectServer } from "./fixtures/serverClient"
import { stopServerIn } from "./fixtures/stopServer"

/**
 * Several machines (step 1 plan, PR 3): the real desktop app with its own
 * local server, and a second PI Lab server (the built server under this
 * test's Node, test mode, its own temp data folder) reached over real ssh
 * through a user-level test sshd on 127.0.0.1 (tests/support/sshTestServer.ts).
 * "Add machine" runs the built `enroll` on the "remote" over ssh.
 */

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const SERVER_ENTRY = join(DESKTOP_DIR, "out", "main", "server.js")
const ENROLL_ENTRY = join(DESKTOP_DIR, "out", "main", "enroll.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string
const { WebSocket } = createRequire(join(DESKTOP_DIR, "package.json"))("ws") as typeof import("ws")

let rootDir: string
let localData: string
let remoteData: string
let remoteServer: ChildProcess | null = null
let sshd: SshTestServer | null = null
let app: ElectronApplication | null = null

/** Quote one word for the remote shell. */
function quote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

async function gitRepo(path: string, file: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", path])
  await writeFile(join(path, file), "# fixture\n")
  const git = (args: string[]) => execFileAsync("git", ["-C", path, ...args])
  await git(["add", "."])
  await git([
    "-c",
    "user.name=PI Lab Test",
    "-c",
    "user.email=test@pi-lab.local",
    "commit",
    "-m",
    "fixture",
  ])
}

test.beforeEach(async () => {
  rootDir = await realpath(await mkdtemp(join(tmpdir(), "pi-lab-e2e-machines-")))
  localData = join(rootDir, "local")
  remoteData = join(rootDir, "remote")
  await mkdir(localData)
  await mkdir(remoteData)
  const env = headlessServerEnv({
    dataDir: remoteData,
    resourcesDir: join(DESKTOP_DIR, "resources"),
    serverEntry: SERVER_ENTRY,
  })
  remoteServer = await startHeadlessServer(
    process.execPath,
    [SERVER_ENTRY, remoteData],
    env,
    remoteData,
  )
  sshd = await startSshTestServer("127.0.0.1")
})

test.afterEach(async () => {
  await app
    ?.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    })
    .catch(() => undefined)
  await app?.close()
  app = null
  await stopServerIn(remoteData)
  if (remoteServer?.exitCode === null) remoteServer.kill("SIGKILL")
  remoteServer = null
  await sshd?.stop()
  sshd = null
  await rm(rootDir, { recursive: true, force: true })
})

async function launch(extraEnv: Record<string, string>): Promise<Page> {
  if (!sshd) throw new Error("no sshd")
  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      // Windows do not take focus on the developer's screen.
      PI_LAB_TEST_HIDE_WINDOWS: "1",
      PI_LAB_DATA_DIR: localData,
      PI_LAB_SOCKET_PATH: join(localData, "daemon.sock"),
      PI_LAB_TEST_SSH_ARGS: JSON.stringify(sshd.clientArgs),
      PI_LAB_TEST_REMOTE_DATA_DIR: remoteData,
      PI_LAB_TEST_REMOTE_ENROLL: `PI_LAB_DATA_DIR=${quote(remoteData)} ${quote(process.execPath)} ${quote(ENROLL_ENTRY)}`,
      ...extraEnv,
    },
  })
  const page = await app.firstWindow()
  await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  return page
}

/** HTTP status of a WebSocket upgrade to the server of `dataDir` with this token (101 when it opens). */
async function upgradeStatus(dataDir: string, token: string): Promise<number> {
  const port = (
    JSON.parse(await readFile(join(dataDir, "server.json"), "utf8")) as { port: number }
  ).port
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/trpc?token=${encodeURIComponent(token)}`)
    socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0))
    socket.on("open", () => {
      socket.close()
      resolve(101)
    })
    socket.on("error", reject)
  })
}

function remoteUpgradeStatus(token: string): Promise<number> {
  return upgradeStatus(remoteData, token)
}

async function turnOnStatusBar(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+Shift+p")
  await page.getByTestId("command-palette-input").fill("status bar")
  const command = page.locator('[data-command-id="settings-status-bar"]')
  await expect(command).toContainText("Turn on Status bar")
  await command.click()
  await expect(page.getByTestId("window-status-bar")).toBeVisible()
}

interface StoredMachine {
  machineId: string
  deviceId: string
  token: string
  sshHost: string
  name: string
}

interface MachineFile {
  machines: StoredMachine[]
  behindPolicy: string
  localServer: string
  defaultMachine: string | null
}

/** What `machines.json` in the app profile holds. */
async function machineFile(): Promise<MachineFile> {
  return JSON.parse(await readFile(join(localData, "machines.json"), "utf8")) as MachineFile
}

async function storedMachines(): Promise<StoredMachine[]> {
  return (await machineFile()).machines
}

/** Open Settings > Machines. */
async function openMachinesSettings(page: Page): Promise<void> {
  await page.getByTestId("nav-settings").click()
  await page.getByTestId("settings-nav-machines").click()
  await expect(page.getByTestId("settings-section-machines")).toBeVisible()
}

/** Add a machine with the Settings > Machines form and wait until it is connected. */
async function addMachine(page: Page, sshHost: string, name: string): Promise<void> {
  if (!(await page.getByTestId("settings-section-machines").isVisible())) {
    await openMachinesSettings(page)
  }
  await page.getByTestId("settings-add-machine-host").fill(sshHost)
  await page.getByTestId("settings-add-machine-name").fill(name)
  await page.getByTestId("settings-add-machine-submit").click()
  const row = page.getByTestId("settings-machine").filter({ hasText: name })
  await expect(row).toHaveAttribute("data-state", "connected", { timeout: 60_000 })
}

test("tokens: adding a machine enrolls a device; removing it revokes the token on the remote", async () => {
  test.setTimeout(120_000)
  const page = await launch({})
  if (!sshd) throw new Error("not started")
  await addMachine(page, sshd.host, "Lab server")
  // The machine shows in the sidebar with its state (Settings hides the sidebar).
  await page.getByTestId("settings-back").click()
  await expect(page.getByTestId("sidebar-machine")).toHaveAttribute("data-state", "connected")

  const [stored] = await storedMachines()
  if (!stored) throw new Error("machine not stored")
  const remote = connectServer(remoteData)
  const remoteHello = await remote.client.server.hello.query()
  const remoteDevices = await remote.client.server.devices.list.query()
  remote.close()
  expect(stored).toMatchObject({
    machineId: remoteHello.machineId,
    name: "Lab server",
    sshHost: sshd.host,
  })
  expect(remoteDevices.find((device) => device.id === stored.deviceId)?.name).toMatch(/^PI Lab on /)
  expect(await remoteUpgradeStatus(stored.token)).toBe(101)

  // The sidebar's add action opens Settings > Machines.
  await page.getByTestId("sidebar-add-machine").click()
  await page.getByTestId("settings-machine-remove").click()
  await expect(page.getByTestId("settings-machines-empty")).toBeVisible()
  await expect(page.getByTestId("settings-machine-notice")).toHaveCount(0)
  await page.getByTestId("settings-back").click()
  await expect(page.getByTestId("sidebar-machines")).toHaveCount(0)
  expect(await storedMachines()).toEqual([])
  // The old token is refused on the remote.
  expect(await remoteUpgradeStatus(stored.token)).toBe(401)
})

test("updates: the behind policy offers its three choices and is kept after a restart", async () => {
  test.setTimeout(120_000)
  let page = await launch({})
  await openMachinesSettings(page)
  const policy = page.getByTestId("settings-machines-behind-policy")
  await expect(policy).toHaveValue("auto")
  await expect(policy.locator("option")).toHaveText(["Update automatically", "Ask me", "Never"])
  await expect(page.getByTestId("settings-section-machines")).toContainText(
    "When a machine is behind this app",
  )
  await expect(page.getByTestId("settings-add-machine")).toContainText(
    "If no PI Lab server runs there, PI Lab installs one.",
  )
  await policy.selectOption("ask")
  await expect.poll(async () => (await machineFile()).behindPolicy).toBe("ask")
  await app?.close()
  app = null

  page = await launch({})
  await openMachinesSettings(page)
  await expect(page.getByTestId("settings-machines-behind-policy")).toHaveValue("ask")
})

test("this Mac's devices: a device enrolled on the local server is listed and revoked from Settings", async () => {
  test.setTimeout(120_000)
  const page = await launch({})
  const local = connectServer(localData)
  const created = await local.client.server.devices.create.mutate({ name: "Phone stand-in" })
  local.close()
  await openMachinesSettings(page)
  const device = page.getByTestId("settings-device").filter({ hasText: "Phone stand-in" })
  await expect(device).toHaveAttribute("data-revoked", "false")
  await device.getByTestId("settings-device-revoke").click()
  await expect(device).toHaveAttribute("data-revoked", "true")
  expect(await upgradeStatus(localData, created.token)).toBe(401)
})

/** Close the machine's SSH tunnel and refuse its endpoint (an unreachable machine), or undo that. */
async function setMachineStopped(machineId: string, stopped: boolean): Promise<void> {
  if (!app) throw new Error("not started")
  await app.evaluate(
    async (_electron, input) => {
      const machines = (
        globalThis as {
          piLabTestMachines?: {
            stopForTest: (id: string) => Promise<void>
            startForTest: (id: string) => void
          }
        }
      ).piLabTestMachines
      if (!machines) throw new Error("no machines seam")
      if (input.stopped) await machines.stopForTest(input.machineId)
      else machines.startForTest(input.machineId)
    },
    { machineId, stopped },
  )
}

test("two servers: remote projects show with a badge, run a terminal there, grey out while disconnected", async () => {
  test.setTimeout(180_000)
  const localRepo = join(rootDir, "local-repo")
  const remoteRepo = join(rootDir, "remote-repo")
  await gitRepo(localRepo, "local.md")
  await gitRepo(remoteRepo, "remote.md")
  const remote = connectServer(remoteData)
  await remote.client.projects.open.mutate({ path: remoteRepo })
  remote.close()

  const page = await launch({ PI_LAB_TEST_OPEN_PROJECT: localRepo })
  if (!sshd || !app) throw new Error("not started")
  // Before any machine: no badges, no filter (as today).
  await expect(page.getByTestId("project-card")).toHaveCount(1)
  await expect(page.getByTestId("machine-badge")).toHaveCount(0)
  await expect(page.getByTestId("dashboard-machine-filter")).toHaveCount(0)

  await addMachine(page, sshd.host, "Lab server")
  const machineId = (await storedMachines())[0]?.machineId ?? ""
  await page.getByTestId("settings-back").click()
  // The status bar hosts item: one machine, connected.
  await turnOnStatusBar(page)
  await expect(page.getByTestId("status-bar-machine-dot")).toHaveAttribute(
    "data-state",
    "connected",
  )

  const remoteCard = page.getByTestId("remote-project-card")
  await expect(remoteCard).toHaveCount(1, { timeout: 30_000 })
  await expect(remoteCard).toContainText("remote-repo")
  await expect(remoteCard.getByTestId("machine-badge")).toHaveText("Lab server")
  await expect(page.getByTestId("project-card").getByTestId("machine-badge")).toHaveText("This Mac")
  await expect(page.getByTestId("remote-project-item")).toContainText("remote-repo")

  // The filter by machine.
  const filter = page.getByTestId("dashboard-machine-filter")
  await filter.selectOption(machineId)
  await expect(page.getByTestId("project-card")).toHaveCount(0)
  await expect(remoteCard).toHaveCount(1)
  await filter.selectOption("local")
  await expect(page.getByTestId("project-card")).toHaveCount(1)
  await expect(remoteCard).toHaveCount(0)
  await filter.selectOption("")

  // Open the remote project and run a terminal on that machine's server.
  await remoteCard.click()
  await expect(page).toHaveURL(new RegExp(`#/m/${machineId}/projects/`))
  await page.getByTestId("central-add-menu").click()
  await page.getByTestId("central-add-terminal").click()
  const terminal = page.locator('[data-testid="terminal"]:visible')
  await expect(terminal).toBeVisible({ timeout: 30_000 })
  await terminal.locator(".xterm-helper-textarea").focus()
  await page.keyboard.insertText('printf \'IN-%s\\n\' "$(basename "$PWD")"\r')
  await expect(terminal).toContainText("IN-remote-repo", { timeout: 30_000 })
  // The terminal session lives in the remote server's daemon.
  const check = connectServer(remoteData)
  const sessions = await check.client.terminal.list.query()
  check.close()
  expect(sessions.length).toBeGreaterThan(0)

  // Disconnect the machine: its projects stay, greyed, with their last data.
  await page.keyboard.press("Escape")
  await page.getByTestId("nav-project-dashboard").first().click()
  await setMachineStopped(machineId, true)
  await expect(remoteCard).toHaveAttribute("data-offline", "true", { timeout: 30_000 })
  await expect(remoteCard).toContainText("remote-repo")
  await expect(page.getByTestId("remote-project-item")).toHaveAttribute("data-offline", "true")
  await expect(page.getByTestId("status-bar-machine-dot")).toHaveAttribute(
    "data-state",
    "disconnected",
  )

  // Reconnect: the machine's sockets open again on their own.
  await setMachineStopped(machineId, false)
  await expect(remoteCard).toHaveAttribute("data-offline", "false", { timeout: 30_000 })
})

/** True when a server process for the local data folder runs (its `server.json` pid is alive). */
async function localServerRunning(): Promise<boolean> {
  const discovery = await readFile(join(localData, "server.json"), "utf8").catch(() => null)
  if (discovery === null) return false
  const { pid } = JSON.parse(discovery) as { pid: number }
  return spawnSync("kill", ["-0", String(pid)]).status === 0
}

test("local server and default machine: New project is preset to the default machine and creates the project there; with the local server off the app starts without it", async () => {
  test.setTimeout(240_000)
  const remoteRepo = join(rootDir, "remote-new")
  await gitRepo(remoteRepo, "new.md")
  let page = await launch({})
  if (!sshd) throw new Error("not started")
  await openMachinesSettings(page)
  const localServer = page.getByTestId("settings-local-server")
  await expect(localServer).toHaveValue("always")
  await expect(localServer.locator("option")).toHaveText([
    "Always",
    "Only while PI Lab is open",
    "Off (client only)",
  ])
  // Before any machine: no default machine choice.
  await expect(page.getByTestId("settings-default-machine")).toHaveCount(0)

  await addMachine(page, sshd.host, "Lab server")
  const machineId = (await storedMachines())[0]?.machineId ?? ""
  const defaultMachine = page.getByTestId("settings-default-machine")
  await expect(defaultMachine).toHaveValue("local")
  // Off needs another default machine first.
  await localServer.selectOption("off")
  await expect(page.getByTestId("settings-local-server-error")).toContainText(
    "Choose another default machine",
  )
  await expect(localServer).toHaveValue("always")
  await defaultMachine.selectOption(machineId)
  await expect.poll(async () => (await machineFile()).defaultMachine).toBe(machineId)
  await localServer.selectOption("while-open")
  await expect.poll(async () => (await machineFile()).localServer).toBe("while-open")

  // New project is preset to the default machine; a path field replaces the folder dialog.
  await page.getByTestId("settings-back").click()
  await page.getByTestId("dashboard-add-project").click()
  await expect(page.getByTestId("add-project-machine")).toHaveValue(machineId)
  await page.getByTestId("add-project-folder").click()
  await page.getByTestId("add-project-remote-path").fill(remoteRepo)
  await page.getByTestId("add-project-remote-path-submit").click()
  const remoteCard = page.getByTestId("remote-project-card")
  await expect(remoteCard.filter({ hasText: "remote-new" })).toHaveCount(1, { timeout: 30_000 })
  const remote = connectServer(remoteData)
  const remoteProjects = await remote.client.projects.list.query()
  remote.close()
  expect(remoteProjects.map((project) => project.repoPath)).toContain(remoteRepo)

  // Off: the default cannot be this Mac.
  await openMachinesSettings(page)
  await localServer.selectOption("off")
  await expect.poll(async () => (await machineFile()).localServer).toBe("off")
  await expect(defaultMachine.locator("option")).toHaveText(["Lab server"])
  await app?.close()
  app = null
  expect(await localServerRunning()).toBe(false)

  // The next start has no local server and still lists the machine's projects.
  page = await launch({})
  await expect(
    page.getByTestId("remote-project-card").filter({ hasText: "remote-new" }),
  ).toHaveAttribute("data-offline", "false", { timeout: 30_000 })
  await expect(page.getByTestId("project-card")).toHaveCount(0)
  await expect(page.getByTestId("app-error")).toHaveCount(0)
  expect(await localServerRunning()).toBe(false)
  await page.getByTestId("dashboard-add-project").click()
  await expect(page.getByTestId("add-project-machine").locator("option")).toHaveText(["Lab server"])
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("default-agent-error")).toHaveCount(0)
  await openMachinesSettings(page)
  await expect(page.getByTestId("settings-local-server")).toHaveValue("off")
  await expect(page.getByTestId("settings-section-devices")).toHaveCount(0)
})
