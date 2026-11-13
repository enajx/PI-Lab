import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { readBuildCommit } from "./buildCommit"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-lab-commit-"))
  dirs.push(dir)
  return dir
}

describe("readBuildCommit", () => {
  test("a packaged Alpha reads the commit written at build time", () => {
    const dir = tempDir()
    writeFileSync(join(dir, "package.json"), JSON.stringify({ piLabCommit: "59ed026e" }))
    expect(readBuildCommit(true, dir)).toBe("59ed026e")
  })

  test("a packaged release without a build commit has none", () => {
    const dir = tempDir()
    writeFileSync(join(dir, "package.json"), JSON.stringify({ piLabChannel: "stable" }))
    expect(readBuildCommit(true, dir)).toBeNull()
  })

  test("a source run reads the short commit from git", () => {
    const head = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
      cwd: __dirname,
      encoding: "utf8",
    }).trim()
    expect(readBuildCommit(false, __dirname)).toBe(head)
  })

  test("a source run outside a git checkout shows dev", () => {
    expect(readBuildCommit(false, tempDir())).toBe("dev")
  })
})
