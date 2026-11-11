import { type ChildProcess, execFile, spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, expect, test, vi } from "vitest"
import { killLeftoverWhisperServer, WhisperServerEngine } from "./engine"

const execFileAsync = promisify(execFile)

let dir: string | undefined
let engine: WhisperServerEngine | undefined
const children: ChildProcess[] = []
afterEach(async () => {
  engine?.stop()
  engine = undefined
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill()
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

/**
 * Mocked engine binary: a Node script named whisper-server that logs its PID to
 * `spawned.log` next to it and answers every HTTP request with 200, so /health is ready.
 */
async function fakeWhisperServer(): Promise<{ binary: string; spawned: () => number[] }> {
  dir = await mkdtemp(join(tmpdir(), "pi-lab-engine-"))
  const binary = join(dir, "whisper-server")
  const log = join(dir, "spawned.log")
  await writeFile(
    binary,
    [
      `#!${process.execPath}`,
      'const port = Number(process.argv[process.argv.indexOf("--port") + 1])',
      `require("node:fs").appendFileSync(${JSON.stringify(log)}, process.pid + "\\n")`,
      'require("node:http").createServer((req, res) => res.end("{}")).listen(port, "127.0.0.1")',
    ].join("\n"),
  )
  await chmod(binary, 0o755)
  return {
    binary,
    spawned: () =>
      existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(Number)
        : [],
  }
}

/** The command path of a running process, or null when no process has this PID. */
async function commandOf(pid: number): Promise<string | null> {
  return execFileAsync("ps", ["-p", String(pid), "-o", "comm="]).then(
    ({ stdout }) => stdout.trim() || null,
    () => null,
  )
}

/** Mocked engine binary: concurrent prepare calls for one model start one process. */
test("concurrent prepare calls for the same model start one whisper-server", async () => {
  const fake = await fakeWhisperServer()
  engine = new WhisperServerEngine(fake.binary, join(dir ?? "", "whisper-server.pid"))
  await Promise.all([engine.prepare("/models/a.bin"), engine.prepare("/models/a.bin")])
  expect(engine.status().state).toBe("ready")
  expect(fake.spawned()).toHaveLength(1)
})

/** Mocked engine binary: a prepare for another model leaves no orphaned process behind. */
test("a concurrent prepare for another model leaves only the current whisper-server running", async () => {
  const fake = await fakeWhisperServer()
  engine = new WhisperServerEngine(fake.binary, join(dir ?? "", "whisper-server.pid"))
  const results = await Promise.allSettled([
    engine.prepare("/models/a.bin"),
    engine.prepare("/models/b.bin"),
    engine.prepare("/models/c.bin"),
  ])
  expect(results.at(-1)?.status).toBe("fulfilled")
  expect(engine.status().state).toBe("ready")
  await vi.waitFor(async () => {
    const alive: number[] = []
    for (const pid of fake.spawned()) if (await commandOf(pid)) alive.push(pid)
    expect(alive).toHaveLength(1)
  })
})

/** Mocked engine binary: the running server's PID is recorded, and the record goes on stop. */
test("records the whisper-server PID while it runs", async () => {
  const fake = await fakeWhisperServer()
  const pidFile = join(dir ?? "", "whisper-server.pid")
  engine = new WhisperServerEngine(fake.binary, pidFile)
  await engine.prepare("/models/a.bin")
  expect(Number(await readFile(pidFile, "utf8"))).toBe(fake.spawned()[0])
  engine.stop()
  expect(existsSync(pidFile)).toBe(false)
})

/** Real processes: a whisper-server left by a crashed app is killed; other PIDs are left alone. */
test("kills a leftover whisper-server from the PID record and removes the record", async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-lab-engine-"))
  const pidFile = join(dir, "whisper-server.pid")
  // A process whose command is named whisper-server (macOS sleep, through a symlink).
  const leftoverPath = join(dir, "whisper-server")
  await symlink("/bin/sleep", leftoverPath)
  const leftover = spawn(leftoverPath, ["60"], { stdio: "ignore" })
  children.push(leftover)
  const exited = new Promise((resolve) => leftover.once("exit", resolve))
  await vi.waitFor(async () => expect(await commandOf(leftover.pid ?? 0)).toBe(leftoverPath))
  await writeFile(pidFile, String(leftover.pid))

  await killLeftoverWhisperServer(pidFile)
  await exited
  expect(existsSync(pidFile)).toBe(false)

  // A recorded PID that now belongs to another program is not killed.
  const other = spawn("/bin/sleep", ["60"], { stdio: "ignore" })
  children.push(other)
  await vi.waitFor(async () => expect(await commandOf(other.pid ?? 0)).toBe("/bin/sleep"))
  await writeFile(pidFile, String(other.pid))
  await killLeftoverWhisperServer(pidFile)
  expect(existsSync(pidFile)).toBe(false)
  expect(await commandOf(other.pid ?? 0)).toBe("/bin/sleep")

  // No record: nothing to do.
  await killLeftoverWhisperServer(pidFile)
})
