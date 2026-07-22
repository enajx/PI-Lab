import { access, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { runNonInteractiveProcess } from "./nonInteractiveRunner"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("runNonInteractiveProcess", () => {
  test("inherits the app environment, applies agent env, and uses the exact project cwd", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-lab-one-shot-")))
    tempDirs.push(cwd)
    const started = await runNonInteractiveProcess({
      command: process.execPath,
      args: [
        "-e",
        "process.exit(process.cwd() === process.argv[1] && process.env.PI_LAB_RUN === 'yes' ? 0 : 9)",
        cwd,
      ],
      cwd,
      env: { PI_LAB_RUN: "yes" },
    })

    await expect(started.completion).resolves.toMatchObject({
      code: 0,
      signal: null,
      error: null,
    })
  })

  test("captures the child's full stdout (the run's user-facing output)", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-lab-one-shot-")))
    tempDirs.push(cwd)
    const started = await runNonInteractiveProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('line one\\nline two\\n');process.exit(0)"],
      cwd,
    })

    await expect(started.completion).resolves.toMatchObject({
      code: 0,
      stdout: "line one\nline two\n",
    })
  })

  test("retains only the bounded stdout tail when the output overruns the cap", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-lab-one-shot-")))
    tempDirs.push(cwd)
    // Write well over the 1 MiB stdout cap, ending with a recognizable marker.
    // No process.exit: let the process end naturally so the large pipe write fully
    // flushes (an immediate exit would truncate it mid-drain).
    const started = await runNonInteractiveProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(1024*1024 + 5000) + 'TAIL')"],
      cwd,
    })

    const result = await started.completion
    expect(result.code).toBe(0)
    expect(Buffer.byteLength(result.stdout)).toBe(1024 * 1024)
    expect(result.stdout.endsWith("TAIL")).toBe(true)
  })

  test("reports a non-zero exit and bounded stderr", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-lab-one-shot-"))
    tempDirs.push(cwd)
    const started = await runNonInteractiveProcess({
      command: process.execPath,
      args: ["-e", "process.stderr.write('specific failure');process.exit(17)"],
      cwd,
    })

    await expect(started.completion).resolves.toMatchObject({
      code: 17,
      signal: null,
      error: null,
      stderr: "specific failure",
    })
  })

  test("retains only the bounded stderr tail after the pipe fully closes", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-lab-one-shot-")))
    tempDirs.push(cwd)
    const started = await runNonInteractiveProcess({
      command: process.execPath,
      args: ["-e", "process.stderr.write('x'.repeat(40000) + 'TAIL');process.exit(9)"],
      cwd,
    })

    const result = await started.completion
    expect(result.code).toBe(9)
    expect(Buffer.byteLength(result.stderr)).toBe(32 * 1024)
    expect(result.stderr.endsWith("TAIL")).toBe(true)
  })

  test("treats shell metacharacters in argv as inert data", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-lab-one-shot-")))
    tempDirs.push(cwd)
    const marker = join(cwd, "must-not-exist")
    const prompt = `review; touch ${marker}`
    const started = await runNonInteractiveProcess({
      command: process.execPath,
      args: ["-e", "process.exit(process.argv[1].includes('touch') ? 0 : 9)", prompt],
      cwd,
    })

    await expect(started.completion).resolves.toMatchObject({ code: 0 })
    await expect(access(marker)).rejects.toThrow()
  })

  test("rejects clearly when the executable cannot spawn", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-lab-one-shot-"))
    tempDirs.push(cwd)
    await expect(
      runNonInteractiveProcess({
        command: join(cwd, "missing-harness"),
        args: [],
        cwd,
      }),
    ).rejects.toThrow(/missing-harness|ENOENT/i)
  })
})
