import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { ProcessGroup } from "./processGroup"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** True while the process exists; signal 0 only checks. */
function alive(pid: number): boolean {
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}

/** The first line a group prints: the pid of the `sleep` it started in the background. */
function firstLinePid(group: ProcessGroup): Promise<number> {
  return new Promise((resolvePid) => {
    let text = ""
    group.child.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8")
      const line = /^(\d+)\n/.exec(text)
      if (line) resolvePid(Number(line[1]))
    })
  })
}

describe.skipIf(process.platform === "win32")("ProcessGroup", () => {
  test("its processes end when PI Lab's main process dies without cleanup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-lab-process-group-"))
    directories.push(dir)
    // Stands in for Electron main: a Node process that starts a group and is then killed.
    const script = join(dir, "owner.ts")
    await writeFile(
      script,
      [
        `import { ProcessGroup } from ${JSON.stringify(resolve(__dirname, "processGroup.ts"))}`,
        `const group = new ProcessGroup("/bin/sh", ["-c", "sleep 100 & echo $!; wait"], { cwd: "/", env: process.env })`,
        "group.child.stdout.on('data', (chunk) => process.stdout.write(chunk))",
      ].join("\n"),
    )
    const owner = spawn("node", [script], { stdio: ["ignore", "pipe", "inherit"] })
    const pid = await new Promise<number>((resolvePid) => {
      owner.stdout.on("data", (chunk: Buffer) => resolvePid(Number(chunk.toString().trim())))
    })
    expect(alive(pid)).toBe(true)

    owner.kill("SIGKILL")
    await expect.poll(() => alive(pid), { timeout: 8_000 }).toBe(false)
  })

  test("stop sends SIGTERM, then SIGKILL to the whole group after the grace", async () => {
    // The shell and its sleep ignore SIGTERM, so only SIGKILL ends them.
    const group = new ProcessGroup("/bin/sh", ["-c", "trap '' TERM; sleep 100 & echo $!; wait"], {
      cwd: "/",
      env: process.env,
    })
    const sleepPid = await firstLinePid(group)

    const started = Date.now()
    await group.stop(300)
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
    expect(group.ended).toBe(true)
    await expect.poll(() => alive(sleepPid)).toBe(false)
  })

  test("signals after the group has ended or was killed do nothing", async () => {
    const group = new ProcessGroup("/bin/sh", ["-c", "sleep 100"], { cwd: "/", env: process.env })
    group.signal("SIGKILL")
    // The shell is gone but not yet reaped; a second signal must not throw.
    group.signal("SIGTERM")
    await group.exited
    group.signal("SIGKILL")
    expect(group.ended).toBe(true)
  })
})
