#!/usr/bin/env node
// @ts-check
/**
 * Run native-load validation under Electron before packaging or in CI.
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

/** @returns {string} Installed Electron executable. */
function electronBinary() {
  const require2 = createRequire(join(DESKTOP_DIR, "package.json"))
  // `require("electron")` returns the path to the Electron executable.
  return require2("electron")
}

/** Forward validator arguments and its exit status. */
function main() {
  const electron = electronBinary()
  const forwarded = process.argv.slice(2)
  const result = spawnSync(electron, [VALIDATOR, ...forwarded], {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  })
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}

main()
