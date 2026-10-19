// @ts-check
/**
 * electron-builder `afterPack` hook.
 *
 * On macOS node-pty exec()s `spawn-helper` for every PTY it opens. The
 * executable bit can be lost when the file is copied into the packaged app
 * (and into the asar-unpacked tree), which makes every terminal/agent launch
 * fail at runtime — not at build time. We restore `+x` on any `spawn-helper`
 * we find under the packed app's resources so the packaged app can spawn PTYs.
 *
 * No-op on Windows (no spawn-helper there; node-pty uses conpty).
 */

const { chmodSync, existsSync, readdirSync, statSync } = require("node:fs")
const { join } = require("node:path")
const { Arch } = require("electron-builder")

/** @param {string} dir @param {string} name @returns {string[]} */
function findByName(dir, name) {
  /** @type {string[]} */
  const hits = []
  if (!existsSync(dir)) return hits
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      hits.push(...findByName(full, name))
    } else if (entry.name === name) {
      hits.push(full)
    }
  }
  return hits
}

/** @param {import("electron-builder").AfterPackContext} context */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName === "linux") {
    const targetArch = Arch[context.arch]
    if (process.platform !== "linux" || process.arch !== targetArch) {
      throw new Error(
        `Linux node-pty requires a Linux build host with the target architecture: target linux/${targetArch}, host ${process.platform}/${process.arch}. Package one target on its matching Linux host (--linux --${targetArch}).`,
      )
    }
    return
  }
  if (context.electronPlatformName !== "darwin") return

  // Search the whole app output dir; spawn-helper lives in the asar-unpacked
  // node-pty under Resources, and electron-builder lays that out per-platform.
  const root = context.appOutDir
  const helpers = findByName(root, "spawn-helper")
  if (helpers.length === 0) {
    throw new Error("[after-pack] no node-pty spawn-helper found (check asarUnpack)")
  }
  for (const helper of helpers) {
    const mode = statSync(helper).mode
    chmodSync(helper, mode | 0o111)
    console.log(`[after-pack] +x ${helper}`)
  }
}
