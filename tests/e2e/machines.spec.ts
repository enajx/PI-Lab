import { type ChildProcess, execFile, spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type SshTestServer, startSshTestServer } from "../support/sshTestServer"
import { openAnalysisExperiment } from "./fixtures/analysis"
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
  // A stand-in uvx on the remote server's PATH starts the stand-in notebook server.
  const binDir = join(rootDir, "bin")
  await mkdir(binDir)
  await writeFile(
    join(binDir, "uvx"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(HERE, "fixtures", "notebook-server.cjs")}" "$@"\n`,
  )
  await chmod(join(binDir, "uvx"), 0o755)
  const env = {
    ...headlessServerEnv({
      dataDir: remoteData,
      resourcesDir: join(DESKTOP_DIR, "resources"),
      serverEntry: SERVER_ENTRY,
    }),
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  }
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
  multiMachine: boolean
}

/** What `machines.json` in the app profile holds. */
async function machineFile(): Promise<MachineFile> {
  return JSON.parse(await readFile(join(localData, "machines.json"), "utf8")) as MachineFile
}

async function storedMachines(): Promise<StoredMachine[]> {
  return (await machineFile()).machines
}

/** Open Settings > Machines, with multi-machine as it is. */
async function openMachinesToggle(page: Page): Promise<void> {
  await page.getByTestId("nav-settings").click()
  await page.getByTestId("settings-nav-machines").click()
  await expect(page.getByTestId("settings-section-machines")).toBeVisible()
}

/** Open Settings > Machines and turn multi-machine on when it is off. */
async function openMachinesSettings(page: Page): Promise<void> {
  await openMachinesToggle(page)
  const toggle = page.getByTestId("settings-multi-machine")
  if ((await toggle.getAttribute("aria-checked")) === "false") await toggle.click()
  await expect(page.getByTestId("settings-add-machine")).toBeVisible()
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

test("multi-machine toggle: off on a fresh app with no machine UI; on shows Add machine; locked on while a machine is added; off again hides it", async () => {
  test.setTimeout(120_000)
  const page = await launch({})
  if (!sshd) throw new Error("not started")
  await expect(page.getByTestId("dashboard")).toBeVisible()
  await expect(page.getByTestId("dashboard-machine-filter")).toHaveCount(0)
  await expect(page.getByTestId("sidebar-machine-filter")).toHaveCount(0)
  await expect(page.getByTestId("sidebar-machines")).toHaveCount(0)

  await openMachinesToggle(page)
  const toggle = page.getByTestId("settings-multi-machine")
  await expect(toggle).toHaveAttribute("aria-checked", "false")
  await expect(page.getByTestId("settings-local-server")).toBeVisible()
  await expect(page.getByTestId("settings-add-machine")).toHaveCount(0)
  await expect(page.getByTestId("settings-machines-behind-policy")).toHaveCount(0)
  await expect(page.getByTestId("settings-section-devices")).toHaveCount(0)

  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-checked", "true")
  await expect(page.getByTestId("settings-add-machine")).toBeVisible()
  await expect.poll(async () => (await machineFile()).multiMachine).toBe(true)

  await addMachine(page, sshd.host, "Lab server")
  await expect(toggle).toHaveAttribute("aria-checked", "true")
  await expect(toggle).toBeDisabled()
  await expect(page.getByTestId("settings-section-machines")).toContainText(
    "On while a machine is added. Remove all machines to turn it off.",
  )
  await page.getByTestId("settings-back").click()
  await expect(page.getByTestId("sidebar-machines")).toBeVisible()

  await page.getByTestId("sidebar-add-machine").click()
  await page.getByTestId("settings-machine-remove").click()
  await expect(page.getByTestId("settings-machines-empty")).toBeVisible()
  await expect(toggle).toBeEnabled()
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-checked", "false")
  await expect(page.getByTestId("settings-add-machine")).toHaveCount(0)
  await expect.poll(async () => (await machineFile()).multiMachine).toBe(false)
  await page.getByTestId("settings-back").click()
  await expect(page.getByTestId("sidebar-machines")).toHaveCount(0)
  await expect(page.getByTestId("sidebar-machine-filter")).toHaveCount(0)
})

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
  await remoteCard.getByTestId("remote-project-open").click()
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

test("remote files: browse, search, edit, Download and Upload on another machine; no Finder actions", async () => {
  test.setTimeout(240_000)
  const remoteRepo = join(rootDir, "remote-repo")
  await gitRepo(remoteRepo, "remote.md")
  await mkdir(join(remoteRepo, "data", "deep"), { recursive: true })
  await writeFile(join(remoteRepo, "data", "a.csv"), "x,y\n1,2\n")
  await writeFile(join(remoteRepo, "data", "deep", "b-target.txt"), "deep\n")
  const remote = connectServer(remoteData)
  await remote.client.projects.open.mutate({ path: remoteRepo })
  remote.close()
  const downloads = join(rootDir, "downloads")
  await mkdir(downloads)
  const localFile = join(rootDir, "upload.txt")
  await writeFile(localFile, "from this Mac\n")

  const page = await launch({})
  if (!sshd || !app) throw new Error("not started")
  await addMachine(page, sshd.host, "Lab server")
  await page.getByTestId("settings-back").click()
  await page.getByTestId("remote-project-open").click()
  await expect(page.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })

  // Search: quick open lists the remote project's files.
  await page.getByTestId("launcher-file").click()
  await page.getByTestId("quick-open-input").fill("b-target")
  await expect(page.getByTestId("quick-open-result")).toHaveCount(1, { timeout: 30_000 })
  await page.keyboard.press("Escape")

  // Browse and edit: open a remote file, change it, save; the file on the machine changes.
  await page.getByTestId("panel-tab-files").click()
  const row = page.getByTestId("file-tree-file").filter({ hasText: "remote.md" })
  await row.click()
  const content = page.getByTestId("editor-buffer").locator(".cm-content")
  await expect(content).toContainText("# fixture", { timeout: 30_000 })
  await content.click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.insertText("edited on the Mac\n")
  await page.keyboard.press("ControlOrMeta+s")
  await expect
    .poll(() => readFile(join(remoteRepo, "remote.md"), "utf8"), { timeout: 30_000 })
    .toContain("edited on the Mac")

  // No Finder action for a file on another machine; Download saves it on this Mac.
  await row.click({ button: "right" })
  const menu = page.getByTestId("file-tree-context-menu")
  await expect(menu.getByTestId("file-tree-download")).toHaveText("Download…")
  await expect(menu.getByTestId("file-tree-reveal")).toHaveCount(0)
  await expect(menu.getByTestId("file-tree-copy-path")).toBeVisible()
  const saveTo = async (path: string) =>
    app?.evaluate(({ dialog }, chosen) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: chosen })
    }, path)
  await saveTo(join(downloads, "remote.md"))
  await menu.getByTestId("file-tree-download").click()
  await expect(page.getByTestId("file-tree-transfer")).toContainText(join(downloads, "remote.md"))
  expect(await readFile(join(downloads, "remote.md"), "utf8")).toContain("edited on the Mac")

  // A folder downloads with everything in it.
  const folder = page.getByTestId("file-tree-dir").filter({ hasText: "data" })
  await folder.click({ button: "right" })
  await expect(menu.getByTestId("file-tree-reveal")).toHaveCount(0)
  await saveTo(join(downloads, "data"))
  await menu.getByTestId("file-tree-download").click()
  await expect(page.getByTestId("file-tree-transfer")).toContainText(join(downloads, "data"))
  expect(await readFile(join(downloads, "data", "a.csv"), "utf8")).toBe("x,y\n1,2\n")
  expect(await readFile(join(downloads, "data", "deep", "b-target.txt"), "utf8")).toBe("deep\n")

  // Upload from the folder menu; the tree shows the new file.
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, localFile)
  await folder.click({ button: "right" })
  await menu.getByTestId("file-tree-upload").click()
  await expect
    .poll(() => readFile(join(remoteRepo, "data", "upload.txt"), "utf8").catch(() => ""), {
      timeout: 30_000,
    })
    .toBe("from this Mac\n")
  await expect(page.getByTestId("file-tree-file").filter({ hasText: "upload.txt" })).toBeVisible()

  // Uploading over an existing file asks first; Replace writes the new content.
  await writeFile(localFile, "second version\n")
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
  })
  await folder.click({ button: "right" })
  await menu.getByTestId("file-tree-upload").click()
  await expect
    .poll(() => readFile(join(remoteRepo, "data", "upload.txt"), "utf8"), { timeout: 30_000 })
    .toBe("second version\n")
})

test("a notebook of a project on another machine shows in its tab through a forwarded port (stand-in uvx)", async () => {
  test.setTimeout(180_000)
  const remoteRepo = join(rootDir, "remote-repo")
  await gitRepo(remoteRepo, "remote.md")
  await writeFile(
    join(remoteRepo, "analysis.ipynb"),
    JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }),
  )
  const remote = connectServer(remoteData)
  await remote.client.projects.open.mutate({ path: remoteRepo })
  remote.close()

  const page = await launch({})
  if (!sshd) throw new Error("not started")
  await addMachine(page, sshd.host, "Lab server")
  await page.getByTestId("settings-back").click()
  await page.getByTestId("remote-project-open").click()
  await expect(page.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await page.getByTestId("panel-tab-files").click()
  await page.getByTestId("file-tree-file").filter({ hasText: "analysis.ipynb" }).click()
  await page.getByTestId("editor-open-notebook").click()
  const frame = page.getByTestId("notebook-frame")
  await expect(
    page.frameLocator('[data-testid="notebook-frame"]').locator("#notebook-stand-in"),
  ).toBeVisible({ timeout: 60_000 })
  // The frame loads from a local port forwarded over ssh, not the machine's notebook port.
  const port = Number(new URL((await frame.getAttribute("src")) ?? "").port)
  expect(port < 42_700 || port > 42_799).toBe(true)
  await expect(page.getByTestId("notebook-open-browser")).toHaveCount(0)
  // The stand-in page asks before unloading; PI Lab ignores that at quit, so leave the dialog alone.
  page.on("dialog", () => undefined)
})

test("Tasks, Analysis and LaTeX follow a project on another machine; its HTML report streams from there", async () => {
  test.setTimeout(180_000)
  const localRepo = join(rootDir, "local-repo")
  const remoteRepo = join(rootDir, "remote-repo")
  await gitRepo(localRepo, "local.md")
  await gitRepo(remoteRepo, "remote.md")
  await writeFile(join(remoteRepo, "TODO.md"), "# TODO\n\n- [ ] Remote only task\n")
  await mkdir(join(remoteRepo, "results", "run"), { recursive: true })
  await writeFile(
    join(remoteRepo, "results", "run", "report.html"),
    '<!doctype html><p id="ready">Remote report</p>',
  )
  const remote = connectServer(remoteData)
  await remote.client.projects.open.mutate({ path: remoteRepo })
  remote.close()

  const page = await launch({ PI_LAB_TEST_OPEN_PROJECT: localRepo })
  if (!sshd) throw new Error("not started")
  await addMachine(page, sshd.host, "Lab server")
  const machineId = (await storedMachines())[0]?.machineId ?? ""
  await page.getByTestId("settings-back").click()
  const card = page.getByTestId("remote-project-card")
  await expect(card).toHaveCount(1, { timeout: 30_000 })

  // Tasks: the remote project's TODO.md.
  await card.getByTestId("remote-project-tasks").click()
  await expect(page).toHaveURL(new RegExp(`machineId=${machineId}`))
  await expect(page.getByTestId("science-tasks")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText("Remote only task")).toBeVisible({ timeout: 30_000 })

  // Analysis: the remote project's files; its HTML report streams through the machine.
  await page.getByTestId("nav-project-dashboard").first().click()
  await card.getByTestId("remote-project-analysis").click()
  await openAnalysisExperiment(page, "run")
  await page
    .locator('[data-testid="analysis-file"][data-rel-path="results/run/report.html"]')
    .click()
  await expect(
    page.frameLocator('[data-testid="analysis-preview-html"]').locator("#ready"),
  ).toHaveText("Remote report", { timeout: 30_000 })
  const src = (await page.getByTestId("analysis-preview-html").getAttribute("src")) ?? ""
  expect(new URL(src).host.endsWith(`.${machineId}`)).toBe(true)

  // LaTeX Editor: shows the remote project.
  await page.getByTestId("nav-project-dashboard").first().click()
  await card.getByTestId("remote-project-latex").click()
  await expect(page.getByTestId("science-latex")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("latex-project-select")).toHaveText("remote-repo")
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
