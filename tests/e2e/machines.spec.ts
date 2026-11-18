import { type ChildProcess, execFile } from "node:child_process"
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

/** HTTP status of a WebSocket upgrade to the remote server with this token (101 when it opens). */
async function remoteUpgradeStatus(token: string): Promise<number> {
  const port = (
    JSON.parse(await readFile(join(remoteData, "server.json"), "utf8")) as { port: number }
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

interface StoredMachine {
  machineId: string
  deviceId: string
  token: string
  sshHost: string
  name: string
}

async function storedMachines(): Promise<StoredMachine[]> {
  return JSON.parse(await readFile(join(localData, "machines.json"), "utf8")) as StoredMachine[]
}

test("tokens: adding a machine enrolls a device; removing it revokes the token on the remote", async () => {
  test.setTimeout(120_000)
  await launch({})
  if (!app || !sshd) throw new Error("not started")
  const host = sshd.host
  // Main-process entry the desktop.machines IPC calls use (test seam: no UI yet).
  const added = await app.evaluate(
    async (_electron, input) => {
      const machines = (
        globalThis as { piLabTestMachines?: { add: (i: unknown) => Promise<unknown> } }
      ).piLabTestMachines
      if (!machines) throw new Error("no machines seam")
      return machines.add(input)
    },
    { sshHost: host, name: "Lab server" },
  )
  expect(added).toMatchObject({
    name: "Lab server",
    sshHost: host,
    state: "connected",
    error: null,
  })
  const [stored] = await storedMachines()
  if (!stored) throw new Error("machine not stored")
  const remoteHello = await (async () => {
    const remote = connectServer(remoteData)
    const hello = await remote.client.server.hello.query()
    remote.close()
    return hello
  })()
  expect(stored.machineId).toBe(remoteHello.machineId)
  expect(await remoteUpgradeStatus(stored.token)).toBe(101)

  const removed = await app.evaluate(async (_electron, machineId) => {
    const machines = (
      globalThis as { piLabTestMachines?: { remove: (id: string) => Promise<unknown> } }
    ).piLabTestMachines
    if (!machines) throw new Error("no machines seam")
    return machines.remove(machineId)
  }, stored.machineId)
  expect(removed).toEqual({ revoked: true })
  expect(await storedMachines()).toEqual([])
  expect(await remoteUpgradeStatus(stored.token)).toBe(401)
})
