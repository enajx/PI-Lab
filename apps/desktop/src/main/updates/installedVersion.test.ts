import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { recordInstalledVersion } from "./installedVersion"

test("first launch and unchanged restarts are quiet; a changed installed version is reported once", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-update-version-"))
  const path = join(dir, "version")
  expect(recordInstalledVersion(path, "1.0.0")).toBe(false)
  expect(recordInstalledVersion(path, "1.0.0")).toBe(false)
  expect(recordInstalledVersion(path, "1.1.0")).toBe(true)
  expect(recordInstalledVersion(path, "1.1.0")).toBe(false)
  rmSync(dir, { recursive: true })
})
