import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { DaemonClient } from "./client"
import { DaemonServer } from "./server"

let dir: string
let server: DaemonServer
const clients: DaemonClient[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-lab-jobs-"))
  server = new DaemonServer({ socketPath: join(dir, "daemon.sock") })
  await server.listen()
})
afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  await server.close()
  await rm(dir, { recursive: true, force: true })
})

async function connectClient(): Promise<DaemonClient> {
  const client = new DaemonClient(join(dir, "daemon.sock"))
  clients.push(client)
  await client.connect()
  return client
}

async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("process job deadline exceeded")
}

test("raw pipe job survives disconnect, replays and completes for a new client", async () => {
  const first = await connectClient()
  const job = await first.startProcess({
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write('α\\n');setTimeout(()=>{process.stderr.write('β\\n');process.exit(0)},250)",
    ],
    cwd: dir,
    env: {},
    metadata: { owner: "workflow-1" },
  })
  await until(async () => (await first.attachProcess(job.id)).stdout === "α\n")
  first.close()
  const second = await connectClient()
  let output = ""
  let sequence = -1
  second.on("process-output", (event) => {
    if (event.id === job.id && event.sequence > sequence) {
      sequence = event.sequence
      output += event.chunk
    }
  })
  await second.attachProcess(job.id, (snapshot) => {
    sequence = snapshot.sequence
    output = snapshot.stdout + snapshot.stderr
  })
  await until(async () => !(await second.listProcesses())[0]?.alive)
  const finished = await second.attachProcess(job.id)
  expect(finished?.metadata).toEqual({ owner: "workflow-1" })
  expect(finished.stdoutBytes).toBe(Buffer.byteLength("α\n"))
  expect(finished.stderrBytes).toBe(Buffer.byteLength("β\n"))
  expect(finished?.result).toMatchObject({
    code: 0,
    signal: null,
    stdout: "α\n",
    stderr: "β\n",
    error: null,
  })
  expect(output).toBe("α\nβ\n")
  await second.forgetProcess(job.id)
  expect(await second.listProcesses()).toEqual([])
  await expect(second.attachProcess(job.id)).rejects.toMatchObject({ code: "unknown-process" })
})

test("timeout and explicit stop terminate jobs and retain bounded output", async () => {
  const client = await connectClient()
  const job = await client.startProcess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(1300000));setInterval(()=>{},100)"],
    cwd: dir,
    env: {},
    metadata: {},
    timeoutMs: 250,
  })
  await expect(client.forgetProcess(job.id)).rejects.toThrow("running")
  await until(async () => !(await client.listProcesses())[0]?.alive)
  const finished = await client.attachProcess(job.id)
  expect(finished?.result?.error).toContain("timed out")
  expect(finished?.stdout.length).toBeLessThanOrEqual(1048576)
  await client.forgetProcess(job.id)
  const next = await client.startProcess({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},100)"],
    cwd: dir,
    env: {},
    metadata: {},
  })
  await client.killProcess(next.id)
  await until(async () => !(await client.listProcesses())[0]?.alive)
  expect((await client.attachProcess(next.id)).result?.signal).toBe("SIGKILL")
})

test("missing executable rejects without a phantom live job", async () => {
  const client = await connectClient()
  await expect(
    client.startProcess({
      command: "/missing/pi-lab-executable",
      args: [],
      cwd: dir,
      env: {},
      metadata: {},
    }),
  ).rejects.toThrow()
  expect(await client.listProcesses()).toEqual([])
})

test("stopping a job kills its descendant process as well", async () => {
  const client = await connectClient()
  const job = await client.startProcess({
    command: process.execPath,
    args: [
      "-e",
      "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'inherit'});child.once('spawn',()=>process.stdout.write(String(child.pid)));setInterval(()=>{},100)",
    ],
    cwd: dir,
    env: {},
    metadata: {},
  })
  let descendant = 0
  await until(async () => {
    descendant = Number((await client.attachProcess(job.id)).stdout)
    return descendant > 0
  })
  process.kill(descendant, 0)
  await client.killProcess(job.id)
  await until(async () => {
    try {
      process.kill(descendant, 0)
      return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      return true
    }
  })
})

test("an old daemon that ignores process requests fails explicitly within a bounded wait", async () => {
  const path = join(dir, "old.sock")
  const old = createServer((socket) => socket.on("data", () => {}))
  await new Promise<void>((resolve) => old.listen(path, resolve))
  const client = new DaemonClient(path)
  await client.connect()
  try {
    await expect(client.listProcesses()).rejects.toThrow("running daemon may need an update")
  } finally {
    client.close()
    await new Promise<void>((resolve) => old.close(() => resolve()))
  }
}, 8000)
