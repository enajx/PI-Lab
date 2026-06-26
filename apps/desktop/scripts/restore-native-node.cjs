#!/usr/bin/env node
// @ts-check
/**
 * Restore the desktop's native modules to the *Node* ABI (docs/testing-and-build.md (build & ship)).
 *
 * The inverse of `rebuild-native-electron.cjs`: after building/running the
 * Electron app (which flips better-sqlite3 to the Electron ABI), `bun run test`
 * (Vitest under plain Node) needs the Node-ABI build back. We re-fetch the
 * prebuilt Node binary via `prebuild-install` in the resolved better-sqlite3
 * directory.
 *
 * node-pty is N-API and loads under both runtimes, so nothing to restore there.
 */

const { execFileSync } = require("node:child_process")
const { dirname, join } = require("node:path")

const DESKTOP_DIR = join(__dirname, "..")

/** Absolute dir of the better-sqlite3 package apps/desktop resolves to. */
function betterSqlite3Dir() {
  const pkgJson = require.resolve("better-sqlite3/package.json", { paths: [DESKTOP_DIR] })
  return dirname(pkgJson)
}

function main() {
  const dir = betterSqlite3Dir()
  console.log(`prebuild-install (Node ABI) in ${dir}`)
  // `-r node` forces the Node runtime prebuild (not electron); run from the
  // module dir so prebuild-install picks up its package.json + binary config.
  execFileSync("bunx", ["prebuild-install", "-r", "node"], { stdio: "inherit", cwd: dir })
  console.log("native restore (Node ABI) complete")
}

main()
