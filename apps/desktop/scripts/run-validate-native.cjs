#!/usr/bin/env node
// @ts-check
/**
 * Run `validate-native.cjs` under the *Electron* runtime so the ABI it checks is
 * Electron's (AGENTS.md §12.4). electron-builder packages for whatever ABI the
 * `.node` files were compiled to; this asserts they actually load under Electron
 * before the build is allowed to proceed.
 *
 * It launches the installed Electron binary with `ELECTRON_RUN_AS_NODE=1` (pure
 * Node mode, no window) executing the validator. Any extra args (e.g.
 * `--app <path>`) are forwarded to the validator.
 *
 * Exits with the validator's exit code (nonzero = fail the build loudly).
 */

const { spawnSync } = require("node:child_process")
const { createRequire } = require("node:module")
const { join } = require("node:path")

const DESKTOP_DIR = join(__dirname, "..")
const VALIDATOR = join(__dirname, "validate-native.cjs")

function electronBinary() {
  const require2 = createRequire(join(DESKTOP_DIR, "package.json"))
  // `require("electron")` returns the path to the Electron executable.
  return require2("electron")
}

function main() {
  const electron = electronBinary()
  const forwarded = process.argv.slice(2)
  const result = spawnSync(electron, [VALIDATOR, ...forwarded], {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  })
  process.exit(result.status ?? 1)
}

main()
