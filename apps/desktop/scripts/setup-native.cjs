#!/usr/bin/env node
// @ts-check
/**
 * Normalize node-pty's native layout so `build/Release` is the single source of
 * truth the rest of the build assumes (AGENTS.md Pitfalls #4).
 *
 * Why this exists — node-pty 1.1.0 ships per-platform *prebuilds* and its install
 * script (`node scripts/prebuild.js || node-gyp rebuild`) only builds from source
 * when no prebuild matches. So on macOS the prebuild short-circuits the build and
 * `build/Release` is NEVER created, while:
 *   - node-pty's runtime loader checks `build/Release` first, then `prebuilds/…`;
 *   - the prebuilt `spawn-helper` ships WITHOUT its executable bit, so the macOS
 *     `__APPLE__` posix_spawn path fails at runtime (`posix_spawnp failed.`);
 *   - `validate:native` + electron-builder (`files` strips `prebuilds/`, packs only
 *     `build/Release`) both expect `build/Release` to be populated.
 *
 * This makes `build/Release` real and correct on every platform we build/test:
 *   - macOS (and any platform with a matching prebuild): copy the prebuilt
 *     `pty.node` + `spawn-helper` into `build/Release` (only when missing — a
 *     from-source build is left untouched), then restore `+x` on the helper.
 *   - Linux (no prebuild): node-pty already builds `build/Release/pty.node` from
 *     source on install, and `spawn-helper` is a macOS-only gyp target that the
 *     Linux `forkpty` path never uses — nothing to do.
 *
 * node-pty is N-API (ABI-stable), so the prebuilt binary loads identically under
 * Node (the test job) and Electron (the e2e/packaged app). This script is the
 * ABI-neutral counterpart to `rebuild-native-electron.cjs` (which flips the
 * node-gyp module better-sqlite3 to the Electron ABI); it never touches ABIs, so
 * it is safe to run before either the Node-ABI test job or the Electron build.
 *
 * Idempotent + best-effort: it populates what it can and logs what it did; the
 * hard gate is `validate:native`, which fails loudly if anything is still wrong.
 */

const { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } = require("node:fs")
const { createRequire } = require("node:module")
const { join, resolve } = require("node:path")

const DESKTOP_DIR = join(__dirname, "..")

/** Absolute dir of the node-pty package apps/desktop resolves to. */
function nodePtyDir() {
  const require2 = createRequire(join(DESKTOP_DIR, "package.json"))
  // `require.resolve("node-pty")` → `<node-pty>/lib/index.js`; up two = package root.
  return resolve(require2.resolve("node-pty"), "..", "..")
}

/** Add owner/group/other execute bits to a file (no-op if already +x). */
function ensureExecutable(file) {
  const mode = statSync(file).mode
  if ((mode & 0o111) !== 0o111) {
    chmodSync(file, mode | 0o111)
    console.log(`  +x ${file}`)
  }
}

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
  if (existsSync(helper)) ensureExecutable(helper)

  const pty = join(buildRelease, "pty.node")
  if (existsSync(pty)) {
    console.log(`setup:native — node-pty build/Release ready (${dir})`)
  } else {
    // Linux relies on the install-time node-gyp build; if it's absent here the
    // hard gate (validate:native) will report it. Surface it now too.
    console.warn(`setup:native — no build/Release/pty.node yet at ${buildRelease}`)
  }
}

main()
