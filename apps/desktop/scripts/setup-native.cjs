#!/usr/bin/env node
// @ts-check
/**
 * Prepare node-pty's macOS helper and native layout without changing ABIs.
 * Matching macOS prebuilds are copied into build/Release when missing, and the
 * spawn-helper execute bits are restored. Linux uses its install-time source
 * build. Windows keeps its matching prebuilds, including ConPTY runtime files.
 * It also builds the @pi-lab/pty-termios addon from source with node-gyp when
 * its binary is missing (not on Windows, which has no termios).
 * All native dependencies use N-API and load under Node and Electron.
 */

const { spawnSync } = require("node:child_process")
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

/**
 * Build @pi-lab/pty-termios with node-gyp when its binary is missing.
 * Throws when the build fails or leaves no binary.
 */
function buildPtyTermios() {
  const require2 = createRequire(join(DESKTOP_DIR, "package.json"))
  const dir = resolve(require2.resolve("@pi-lab/pty-termios/package.json"), "..")
  const binary = join(dir, "build", "Release", "pty_termios.node")
  if (existsSync(binary)) {
    console.log(`setup:native — pty-termios ready (${binary})`)
    return
  }
  // node-gyp is a dev dependency of the addon package, so resolve it from there.
  const nodeGyp = createRequire(join(dir, "package.json")).resolve("node-gyp/bin/node-gyp.js")
  console.log(`setup:native — building pty-termios in ${dir}`)
  const result = spawnSync(process.execPath, [nodeGyp, "rebuild"], { cwd: dir, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`setup:native — node-gyp rebuild of pty-termios exited with ${result.status}`)
  }
  if (!existsSync(binary)) throw new Error(`setup:native — node-gyp left no binary at ${binary}`)
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

  buildPtyTermios()
}

main()
