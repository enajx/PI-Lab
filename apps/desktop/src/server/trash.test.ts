import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { trashPath } from "./trash"

describe.skipIf(process.platform !== "darwin")("trashPath", () => {
  it("moves a file to the Trash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pl-trash-"))
    const file = join(dir, `trash-me-${Date.now()}.txt`)
    writeFileSync(file, "x")
    await trashPath(file)
    expect(existsSync(file)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it("rejects with a clear error for a missing path", async () => {
    await expect(trashPath("/nonexistent/pl-trash-missing")).rejects.toThrow(/Could not move/)
  })
})
