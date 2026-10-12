import { appendFile, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { MAX_NPY_BYTES, previewDataFile } from "./discover"

// Only the overlap timing is injected. The preview and concurrent append use
// real files, file handles, reads, and stats.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, open: vi.fn(actual.open), stat: vi.fn(actual.stat) }
})
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
let root: string

afterEach(async () => {
  vi.mocked(open).mockReset().mockImplementation(actualFs.open)
  vi.mocked(stat).mockReset().mockImplementation(actualFs.stat)
  await rm(root, { recursive: true, force: true })
})

test("NumPy growth after stat stops at the actual byte cap (real handles, injected timing)", async () => {
  root = await mkdtemp(join(tmpdir(), "pi-lab-numpy-growth-"))
  const path = join(root, "growing.npy")
  const header = "{'descr': '<f8', 'fortran_order': False, 'shape': (1,), }\n"
  const prefix = Buffer.alloc(10)
  prefix[0] = 0x93
  prefix.write("NUMPY", 1, "ascii")
  prefix[6] = 1
  prefix.writeUInt16LE(header.length, 8)
  const initial = Buffer.concat([prefix, Buffer.from(header, "ascii"), Buffer.alloc(8)])
  await writeFile(path, initial)
  let bytesRead = 0
  let grew = false
  vi.mocked(stat).mockImplementation(async (...args) => {
    const before = await actualFs.stat(...args)
    if (!grew) {
      grew = true
      await appendFile(path, Buffer.alloc(MAX_NPY_BYTES + 1024 - initial.length))
    }
    return before
  })
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actualFs.open(...args)
    return new Proxy(handle, {
      get(file, property) {
        if (property === "read")
          return async (...params: Parameters<typeof file.read>) => {
            const result = await file.read(...params)
            bytesRead += result.bytesRead
            return result
          }
        const value = Reflect.get(file, property)
        return typeof value === "function" ? value.bind(file) : value
      },
    })
  })

  const preview = await previewDataFile(path, "growing.npy")
  expect(preview).toMatchObject({ type: "metadata", note: "Array too large to decode inline" })
  expect(grew).toBe(true)
  expect(bytesRead).toBe(MAX_NPY_BYTES + 1)
})
