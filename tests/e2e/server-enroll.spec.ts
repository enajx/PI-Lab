import { type ChildProcess, execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { headlessServerEnv, startHeadlessServer } from "./fixtures/headlessServer"
import { expect, test } from "./fixtures/playwright"
import { connectServer, readServerDiscovery } from "./fixtures/serverClient"
import { stopServerIn } from "./fixtures/stopServer"

/**
 * Enroll command (step 1 plan, PR 3): run on the server machine, it asks the
 * running server for a new device and prints `{ machineId, deviceId, token }`
 * once. Runs the built server and the built enroll entry under this test's
 * Node (no Electron), in test mode with a temp data folder.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const SERVER_ENTRY = join(DESKTOP_DIR, "out", "main", "server.js")
const ENROLL_ENTRY = join(DESKTOP_DIR, "out", "main", "enroll.js")
const execFileAsync = promisify(execFile)
// `ws` is a dependency of the desktop app, not the repo root.
const { WebSocket } = createRequire(join(DESKTOP_DIR, "package.json"))("ws") as typeof import("ws")

let rootDir: string
let dataDir: string
let server: ChildProcess | null = null

test.beforeEach(async () => {
  rootDir = await realpath(await mkdtemp(join(tmpdir(), "pi-lab-e2e-enroll-")))
  dataDir = join(rootDir, "data")
  await mkdir(dataDir)
})

test.afterEach(async () => {
  await stopServerIn(dataDir)
  if (server?.exitCode === null) server.kill("SIGKILL")
  server = null
  await rm(rootDir, { recursive: true, force: true })
})

/** HTTP status of a WebSocket upgrade with this token (101 when it opens). */
function upgradeStatus(port: number, token: string): Promise<number> {
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

test("enroll prints a device token once; it connects, and is refused after revoke", async () => {
  test.setTimeout(120_000)
  const env = headlessServerEnv({
    dataDir,
    resourcesDir: join(DESKTOP_DIR, "resources"),
    serverEntry: SERVER_ENTRY,
  })
  server = await startHeadlessServer(process.execPath, [SERVER_ENTRY, dataDir], env, dataDir)

  const { stdout } = await execFileAsync(
    process.execPath,
    [ENROLL_ENTRY, "--name", "Test laptop"],
    { env },
  )
  const enrolled = JSON.parse(stdout) as { machineId: string; deviceId: string; token: string }
  expect(Object.keys(enrolled).sort()).toEqual(["deviceId", "machineId", "token"])

  // The printed token connects over the real WebSocket as the new device.
  const device = connectServer(dataDir, enrolled.token)
  const hello = await device.client.server.hello.query()
  expect(hello.machineId).toBe(enrolled.machineId)
  device.close()

  const local = connectServer(dataDir)
  const listed = await local.client.server.devices.list.query()
  expect(listed.find((entry) => entry.id === enrolled.deviceId)?.name).toBe("Test laptop")
  await local.client.server.devices.revoke.mutate({ id: enrolled.deviceId })
  local.close()

  const port = readServerDiscovery(dataDir)?.port ?? 0
  expect(await upgradeStatus(port, enrolled.token)).toBe(401)
})

test("enroll without a running server fails with a message and prints no token", async () => {
  const env = headlessServerEnv({
    dataDir,
    resourcesDir: join(DESKTOP_DIR, "resources"),
    serverEntry: SERVER_ENTRY,
  })
  const failed = await execFileAsync(process.execPath, [ENROLL_ENTRY, "--name", "Test laptop"], {
    env,
  }).then(
    () => null,
    (error: { code: number; stdout: string; stderr: string }) => error,
  )
  expect(failed?.code).toBe(1)
  expect(failed?.stdout).toBe("")
  expect(failed?.stderr).toContain("No PI Lab server runs")
})
