import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { expect, test } from "vitest"

const repoRoot = join(import.meta.dirname, "../../..")

function declared(packageJson: string, name: string): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, packageJson), "utf8")) as {
    dependencies: Record<string, string>
  }
  return manifest.dependencies[name] ?? ""
}

function installed(fromPackageJson: string, name: string): string {
  const require = createRequire(join(repoRoot, fromPackageJson))
  const manifest = require(`${name}/package.json`) as { version: string }
  return manifest.version
}

// Replay, snapshots and screen refreshes need the renderer's xterm to parse
// bytes exactly like the daemon's headless xterm.
test("the renderer pins the exact xterm version of the daemon's headless emulator", () => {
  const daemon = declared("packages/pty-daemon/package.json", "@xterm/headless")
  expect(daemon).toMatch(/^\d+\.\d+\.\d+$/)
  expect(declared("apps/desktop/package.json", "@xterm/xterm")).toBe(daemon)
  expect(installed("apps/desktop/package.json", "@xterm/xterm")).toBe(daemon)
  expect(installed("packages/pty-daemon/package.json", "@xterm/headless")).toBe(daemon)
})
