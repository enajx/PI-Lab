#!/usr/bin/env node
// @ts-check
/**
 * Prepare node-pty's macOS helper and native layout without changing ABIs.
 * Matching macOS prebuilds are copied into build/Release when missing, and the
 * spawn-helper execute bits are restored. Linux uses its install-time source
 * build. Windows keeps its matching prebuilds, including ConPTY runtime files.
 * Both native dependencies use N-API and load under Node and Electron.
 */

const { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } = require("node:fs")
const { createRequire } = require("node:module")
const { join, resolve } = require("node:path")

const DESKTOP_DIR = join(__dirname, "..")

/** @returns {string} Absolute node-pty package directory. */
function nodePtyDir() {
  const require2 = createRequire(join(DESKTOP_DIR, "package.json"))
  // `require.resolve("node-pty")` → `<node-pty>/lib/index.js`; up two = package root.
  return resolve(require2.resolve("node-pty"), "..", "..")
}

/** @param {string} file Add all execute bits when missing. */
function ensureExecutable(file) {
  const mode = statSync(file).mode
  if ((mode & 0o111) !== 0o111) {
    chmodSync(file, mode | 0o111)
    console.log(`  +x ${file}`)
  }
}

/** Prepare the host's native layout or fail with the missing file. */
function main() {
  if (process.platform === "win32") {
    console.log("setup:native — Windows uses conpty (no spawn-helper); nothing to do")
    return
  }

  const dir = nodePtyDir()
  const buildRelease = join(dir, "build", "Release")
  const prebuildDir = join(dir, "prebuilds", `${process.platform}-${process.arch}`)

  // Platforms with a matching prebuild (macOS) never run the from-source build, so
  // seed `build/Release` from the prebuilt binaries when it isn't already populated.
  if (existsSync(prebuildDir)) {
    mkdirSync(buildRelease, { recursive: true })
    for (const name of ["pty.node", "spawn-helper"]) {
      const src = join(prebuildDir, name)
      const dest = join(buildRelease, name)
      if (existsSync(src) && !existsSync(dest)) {
        copyFileSync(src, dest)
        console.log(`  copied ${name} from prebuilds/${process.platform}-${process.arch}`)
      }
    }
  }

  // node-pty exec()s spawn-helper on macOS; the prebuilt copy ships non-executable.
  const helper = join(buildRelease, "spawn-helper")
  if (process.platform === "darwin" && !existsSync(helper)) {
    throw new Error(`spawn-helper missing at ${helper}`)
  }
  if (existsSync(helper)) ensureExecutable(helper)

  const pty = join(buildRelease, "pty.node")
  if (existsSync(pty)) {
    console.log(`setup:native — node-pty build/Release ready (${dir})`)
  } else {
    throw new Error(`setup:native — no build/Release/pty.node at ${buildRelease}`)
  }
}

main()
