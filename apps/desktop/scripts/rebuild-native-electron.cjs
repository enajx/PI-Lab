#!/usr/bin/env node
// @ts-check
/**
 * Rebuild the desktop's native modules for the *Electron* ABI (docs/testing-and-build.md (build & ship)).
 *
 * better-sqlite3 is a node-gyp addon: on `bun install` it's prebuilt for the
 * host *Node* ABI (what `bun run test` needs), so it won't load inside Electron.
 * This runs `@electron/rebuild` against the installed Electron version to flip it
 * to the Electron ABI before packaging / launching the app.
 *
 * node-pty is N-API (ABI-stable across Node and Electron) so it doesn't strictly
 * need rebuilding, but we let @electron/rebuild see the whole tree; only
 * better-sqlite3 is actually recompiled (`-o better-sqlite3`).
 *
 * Run via `bun install` scripts? No — explicitly, as part of `package` /
 * `package:prod` and in CI's Electron-ABI job, so the Node-ABI install stays
 * intact for the unit-test job.
 */

const { execFileSync } = require("node:child_process")
const { createRequire } = require("node:module")
const { join } = require("node:path")

const DESKTOP_DIR = join(__dirname, "..")

function electronVersion() {
  const require2 = createRequire(join(DESKTOP_DIR, "package.json"))
  return require2("electron/package.json").version
}

function main() {
  const version = electronVersion()
  console.log(`@electron/rebuild → Electron ${version} (module: better-sqlite3)`)
  execFileSync(
    "bunx",
    ["@electron/rebuild", "-v", version, "-f", "-m", DESKTOP_DIR, "-o", "better-sqlite3"],
    { stdio: "inherit" },
  )
  console.log("native rebuild (Electron ABI) complete")
}

main()
