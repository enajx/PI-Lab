import { mkdtemp, open, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { readTextSnapshot } from "./fs"

// Only the timing boundary is injected; every handle, read, stat, write and
// rename uses the real filesystem. This makes overlapping writers deterministic.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, open: vi.fn(actual.open) }
})
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-lab-snapshot-"))
})
afterEach(async () => {
  vi.mocked(open).mockReset().mockImplementation(actualFs.open)
  await rm(root, { recursive: true, force: true })
})

/** Perform a real filesystem mutation after each selected read finishes. */
function afterRead(mutate: (attempt: number) => Promise<void>): void {
  let attempt = 0
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actualFs.open(...args)
    let mutated = false
    return new Proxy(handle, {
      get(target, property) {
        if (property === "read")
          return async (...args: Parameters<typeof target.read>) => {
            const content = await target.read(...args)
            if (!mutated) {
              mutated = true
              await mutate(++attempt)
            }
            return content
          }
        const value = Reflect.get(target, property)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  })
}

describe("coherent text snapshots with real files and injected overlap timing", () => {
  test.each([
    "same-size write",
    "atomic replacement",
  ] as const)("retries a %s during the read", async (kind) => {
    const target = join(root, "file.txt")
    await writeFile(target, "first")
    afterRead(async (attempt) => {
      if (attempt !== 1) return
      if (kind === "same-size write") await writeFile(target, "other")
      else {
        await writeFile(join(root, "replacement"), "replacement text")
        await rename(join(root, "replacement"), target)
      }
    })
    const snapshot = await readTextSnapshot(target)
    const expected = kind === "same-size write" ? "other" : "replacement text"
    const current = await stat(target)
    expect(snapshot).toEqual({
      status: "text",
      exists: true,
      content: expected,
      baseline: { exists: true, mtimeMs: current.mtimeMs, size: current.size },
    })
    expect(open).toHaveBeenCalledTimes(2)
  })

  test("stops after three changing versions with a visible error", async () => {
    const target = join(root, "file.txt")
    await writeFile(target, "initial")
    afterRead(async (attempt) => {
      await writeFile(target, "changing".repeat(attempt))
    })
    await expect(readTextSnapshot(target)).rejects.toThrow("File kept changing while reading")
    expect(open).toHaveBeenCalledTimes(3)
  })

  test("returns the missing-file fingerprint when a file disappears during its read", async () => {
    const target = join(root, "file.txt")
    await writeFile(target, "initial")
    afterRead(async () => {
      await rm(target)
    })
    expect(await readTextSnapshot(target)).toEqual({
      status: "missing",
      exists: false,
      content: "",
      baseline: { exists: false, mtimeMs: 0, size: 0 },
    })
  })
})

test("growing file reads at most cap plus one byte (mocked timing, real file handles)", async () => {
  const target = join(root, "growing")
  await writeFile(target, "small")
  let bytesRead = 0
  let grown = false
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actualFs.open(...args)
    return new Proxy(handle, {
      get(file, property) {
        if (property === "read")
          return async (...params: Parameters<typeof file.read>) => {
            if (!grown) {
              grown = true
              await writeFile(target, "x".repeat(12_000_000))
            }
            const result = await file.read(...params)
            bytesRead += result.bytesRead
            return result
          }
        const value = Reflect.get(file, property)
        return typeof value === "function" ? value.bind(file) : value
      },
    })
  })
  const result = await readTextSnapshot(target)
  expect(result).toMatchObject({ status: "oversized", size: 12_000_000 })
  expect(result).not.toHaveProperty("content")
  expect(bytesRead).toBe(10_000_001)
  expect(open).toHaveBeenCalledTimes(2)
})
