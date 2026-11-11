import { readFileSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { type RenderPlan, runRender, stopRunningRenders } from "./render"

/** Render runs with a stand-in tool: a shell that starts a background `sleep` and waits. */

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

/** A plan whose command starts `sleep 100` (like a kernel a render starts) and writes its pid. */
async function hangingPlan(): Promise<{ plan: RenderPlan; pidFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-render-"))
  directories.push(dir)
  const pidFile = join(dir, "child.pid")
  return {
    pidFile,
    plan: {
      command: "/bin/sh",
      args: ["-c", `sleep 100 & echo $! > "${pidFile}"; wait`],
      cwd: dir,
      setupFiles: [],
      outputPath: join(dir, "out.html"),
    },
  }
}

async function childPid(pidFile: string): Promise<number> {
  await expect.poll(async () => readFile(pidFile, "utf8").catch(() => "")).toMatch(/\d/)
  return Number((await readFile(pidFile, "utf8")).trim())
}

describe.skipIf(process.platform === "win32")("runRender", () => {
  test("a render over its time limit is stopped with everything it started", async () => {
    const { plan, pidFile } = await hangingPlan()
    const outcome = await runRender(plan, { PATH: "/usr/bin:/bin" }, 800)
    expect(outcome.ok).toBe(false)
    expect(outcome.log).toContain("did not finish within 1 seconds")
    await expect.poll(() => alive(Number(readFileSync(pidFile, "utf8").trim()))).toBe(false)
  })

  test("stopRunningRenders stops a running render and what it started (app quit)", async () => {
    const { plan, pidFile } = await hangingPlan()
    const running = runRender(plan, { PATH: "/usr/bin:/bin" }, 60_000)
    const pid = await childPid(pidFile)
    await stopRunningRenders()
    const outcome = await running
    expect(outcome.ok).toBe(false)
    await expect.poll(() => alive(pid)).toBe(false)
  })
})
