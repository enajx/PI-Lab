// @ts-check
/**
 * electron-builder `afterPack` hook (AGENTS.md §12.4).
 *
 * node-pty exec()s a small `spawn-helper` binary for every PTY it opens. The
 * executable bit can be lost when the file is copied into the packaged app
 * (and into the asar-unpacked tree), which makes every terminal/agent launch
 * fail at runtime — not at build time. We restore `+x` on any `spawn-helper`
 * we find under the packed app's resources so the packaged app can spawn PTYs.
 *
 * No-op on Windows (no spawn-helper there; node-pty uses conpty).
 */

const { chmodSync, existsSync, readdirSync, statSync } = require("node:fs")
const { join } = require("node:path")

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
  if (context.electronPlatformName === "win32") return

  // Search the whole app output dir; spawn-helper lives in the asar-unpacked
  // node-pty under Resources, and electron-builder lays that out per-platform.
  const root = context.appOutDir
  const helpers = findByName(root, "spawn-helper")
  for (const helper of helpers) {
    try {
      const mode = statSync(helper).mode
      // Add owner/group/other execute bits (0o111).
      chmodSync(helper, mode | 0o111)
      console.log(`[after-pack] +x ${helper}`)
    } catch (err) {
      console.warn(`[after-pack] could not chmod ${helper}: ${String(err)}`)
    }
  }
  if (helpers.length === 0) {
    console.warn("[after-pack] no node-pty spawn-helper found to chmod (check asarUnpack)")
  }
}
