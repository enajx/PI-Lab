import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DaemonClient, DaemonServer } from "@pi-lab/pty-daemon"
import { afterEach, beforeEach, expect, test } from "vitest"
import {
  ALPHA_RESET_PROBE_FLAG,
  assertAlphaResetDaemonIdle,
  assertAlphaResetDaemonIdleSync,
} from "./alphaResetGuard"

let dir: string
let socketPath: string
let daemon: DaemonServer | null = null
let client: DaemonClient | null = null
let unresponsive: Server | null = null
const sockets: Socket[] = []
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-lab-alpha-idle-"))
  socketPath = join(dir, "daemon.sock")
})
afterEach(async () => {
  client?.close()
  client = null
  await daemon?.close()
  daemon = null
  for (const socket of sockets.splice(0)) socket.destroy()
  const passiveServer = unresponsive
  if (passiveServer) await new Promise<void>((resolve) => passiveServer.close(() => resolve()))
  unresponsive = null
  await rm(dir, { recursive: true, force: true })
})

test("no existing daemon permits a new-build reset without spawning one", async () => {
  await expect(assertAlphaResetDaemonIdle(socketPath)).resolves.toBeUndefined()
})

test("an unexpected non-socket file fails closed", async () => {
  await writeFile(socketPath, "stale socket path")
  await expect(assertAlphaResetDaemonIdle(socketPath)).rejects.toMatchObject({ code: "ENOTSOCK" })
})

test("an idle real daemon permits reset", async () => {
  daemon = new DaemonServer({ socketPath })
  await daemon.listen()
  await expect(assertAlphaResetDaemonIdle(socketPath)).resolves.toBeUndefined()
})

test("real detached pipe jobs block reset and remain alive", async () => {
  daemon = new DaemonServer({ socketPath })
  await daemon.listen()
  client = new DaemonClient(socketPath)
  await client.connect()
  const job = await client.startProcess({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: dir,
    env: {},
    metadata: {},
  })
  await expect(assertAlphaResetDaemonIdle(socketPath)).rejects.toThrow(/Close.*terminals.*jobs/i)
  expect((await client.listProcesses()).find(({ id }) => id === job.id)?.alive).toBe(true)
})

test("a real live terminal blocks reset and remains alive", async () => {
  daemon = new DaemonServer({ socketPath })
  await daemon.listen()
  client = new DaemonClient(socketPath)
  await client.connect()
  const session = await client.spawn({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: dir,
  })
  await expect(assertAlphaResetDaemonIdle(socketPath)).rejects.toThrow(/Close.*terminals.*jobs/i)
  expect((await client.list()).find(({ id }) => id === session.id)?.alive).toBe(true)
})

/** Real Unix socket with no protocol replies: unknown state must fail closed within the bound. */
test("an unresponsive daemon blocks reset with a bounded error", async () => {
  const passiveServer = createServer((socket) => sockets.push(socket))
  unresponsive = passiveServer
  await new Promise<void>((resolve, reject) => {
    passiveServer.once("error", reject)
    passiveServer.listen(socketPath, resolve)
  })
  const started = Date.now()
  await expect(assertAlphaResetDaemonIdle(socketPath)).rejects.toThrow(/timed out/i)
  expect(Date.now() - started).toBeLessThan(4000)
}, 5000)

test("the startup check skips the probe when no daemon socket exists", () => {
  expect(() =>
    assertAlphaResetDaemonIdleSync(join(dir, "missing-daemon-entry.js"), socketPath),
  ).not.toThrow()
})

/** Stub probe entry (not the bundled daemon): checks the argv contract and exit-code handling. */
test("the startup check runs the daemon entry in probe mode and surfaces its refusal", async () => {
  await writeFile(socketPath, "socket stand-in")
  const entry = join(dir, "probe.cjs")
  await writeFile(
    entry,
    `const [flag, socket] = process.argv.slice(2)
if (flag !== ${JSON.stringify(ALPHA_RESET_PROBE_FLAG)} || socket !== ${JSON.stringify(socketPath)} || process.env.ELECTRON_RUN_AS_NODE !== "1") process.exit(3)
if (process.env.PI_LAB_TEST_PROBE_REFUSES === "1") { process.stderr.write("Close Alpha terminals first\\n"); process.exit(1) }`,
  )
  expect(() => assertAlphaResetDaemonIdleSync(entry, socketPath)).not.toThrow()
  process.env.PI_LAB_TEST_PROBE_REFUSES = "1"
  try {
    expect(() => assertAlphaResetDaemonIdleSync(entry, socketPath)).toThrow(
      "Close Alpha terminals first",
    )
  } finally {
    delete process.env.PI_LAB_TEST_PROBE_REFUSES
  }
})
