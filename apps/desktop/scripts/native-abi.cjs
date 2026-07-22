#!/usr/bin/env node
// @ts-check
/**
 * Cache-aware ABI swap for better-sqlite3 (md/engineering/testing-and-build.md).
 *
 * better-sqlite3 is a node-gyp addon, so its compiled `better_sqlite3.node` is
 * ABI-specific: the Node test runtime (`bun run test`, Vitest) needs the Node ABI;
 * the Electron app (`dev` / packaged) needs the Electron ABI. Only ONE binary sits
 * in `build/Release` at a time, so moving between the two used to mean a re-fetch
 * (Node, via prebuild-install) or a recompile (Electron, via @electron/rebuild)
 * on every switch. node-pty is N-API (ABI-stable) and never needs this.
 *
 * This keeps one binary PER ABI in a local, gitignored cache
 * (`apps/desktop/.native-abi-cache/`). `ensureAbi(target)`:
 *   1. probes the in-place binary UNDER the consuming runtime (Node or
 *      Electron-as-node) — if it already loads, it's correct → cache it, done;
 *   2. else, if a cached binary for the target ABI exists → copy it into place and
 *      re-verify (a millisecond file-copy, no compile, works offline);
 *   3. else → run the real build once (prebuild-install / @electron/rebuild),
 *      verify, and populate the cache for next time.
 *
 * So the FIRST switch to each ABI pays the build cost once; every switch after is a
 * copy. Idempotent: when the ABI is already correct it's a cheap no-op probe.
 */

const { execFileSync, spawnSync } = require("node:child_process")
const { copyFileSync, existsSync, mkdirSync, statSync } = require("node:fs")
const { createRequire } = require("node:module")
const { dirname, join } = require("node:path")

const DESKTOP_DIR = join(__dirname, "..")
const CACHE_DIR = join(DESKTOP_DIR, ".native-abi-cache")
// Local cache is per-machine; tag by platform+arch so a shared checkout never
// loads a binary built for a different OS/arch.
const PLATFORM_TAG = `${process.platform}-${process.arch}`

/** Absolute dir of the better-sqlite3 package apps/desktop resolves to. */
function betterSqlite3Dir() {
  return dirname(require.resolve("better-sqlite3/package.json", { paths: [DESKTOP_DIR] }))
}

/** The single `.node` binary whose ABI we flip. */
function betterSqlite3Bin() {
  return join(betterSqlite3Dir(), "build", "Release", "better_sqlite3.node")
}

function electronBinary() {
  return createRequire(join(DESKTOP_DIR, "package.json"))("electron")
}

function electronVersion() {
  return createRequire(join(DESKTOP_DIR, "package.json"))("electron/package.json").version
}

function cachePathFor(/** @type {number} */ abi) {
  return join(CACHE_DIR, `better_sqlite3-abi${abi}-${PLATFORM_TAG}.node`)
}

/**
 * Load the in-place binary under the target runtime and report its module ABI +
 * whether it loaded. Runs in a child process (Node's own binary, or Electron with
 * ELECTRON_RUN_AS_NODE=1) so a wrong-ABI load can't poison this process, and so the
 * reported ABI is exactly the one the consumer will use.
 * @param {"node"|"electron"} target
 * @returns {{ abi: number, loads: boolean }}
 */
function probe(target, /** @type {string} */ bin) {
  const snippet =
    "try{require(process.env.__PROBE_BIN);" +
    "process.stdout.write(JSON.stringify({abi:process.versions.modules,loads:true}))}" +
    "catch(e){process.stdout.write(JSON.stringify({abi:process.versions.modules,loads:false}))}"
  const cmd = target === "electron" ? electronBinary() : process.execPath
  const env = { ...process.env, __PROBE_BIN: bin }
  if (target === "electron") env.ELECTRON_RUN_AS_NODE = "1"
  const res = spawnSync(cmd, ["-e", snippet], { env, encoding: "utf8" })
  if (!res.stdout) {
    throw new Error(
      `${target} ABI probe failed: ${res.stderr || res.error || `exit ${res.status}`}`,
    )
  }
  return JSON.parse(res.stdout.trim())
}

/** Copy the current in-place binary into the cache slot for its ABI (if not already there). */
function saveToCache(/** @type {string} */ bin, /** @type {number} */ abi) {
  mkdirSync(CACHE_DIR, { recursive: true })
  const dest = cachePathFor(abi)
  if (existsSync(dest) && statSync(dest).size === statSync(bin).size) return
  copyFileSync(bin, dest)
}

/** Run the real (expensive) build that produces the target ABI in place. */
function build(/** @type {"node"|"electron"} */ target) {
  if (target === "node") {
    // `-r node` forces the Node-runtime prebuilt (a download, not a compile).
    execFileSync("bunx", ["prebuild-install", "-r", "node"], {
      stdio: "inherit",
      cwd: betterSqlite3Dir(),
    })
  } else {
    const version = electronVersion()
    console.log(`@electron/rebuild → Electron ${version} (module: better-sqlite3)`)
    execFileSync(
      "bunx",
      ["@electron/rebuild", "-v", version, "-f", "-m", DESKTOP_DIR, "-o", "better-sqlite3"],
      { stdio: "inherit" },
    )
  }
}

/**
 * Prove better-sqlite3 actually works under the consuming runtime: load the
 * PACKAGE (so it resolves its own binary however it likes) and run a trivial
 * query, in a child process (Node, or Electron-as-node) so a bad load can't
 * poison this process. Returns true only on a clean "ok".
 *
 * This is crash-robust: a wrong-ABI node-gyp binary that *segfaults* the child
 * (instead of throwing) simply yields no "ok" → false, so the caller falls
 * through to the legacy swap rather than dying on the probe.
 * @param {"node"|"electron"} target
 */
function moduleLoadsUnder(target) {
  const pkgEntry = require.resolve("better-sqlite3", { paths: [DESKTOP_DIR] })
  const snippet =
    "try{const D=require(process.env.__PROBE_PKG);const db=new D(':memory:');" +
    "db.prepare('select 1 as x').get();process.stdout.write('ok')}" +
    "catch(e){process.stdout.write('no')}"
  const cmd = target === "electron" ? electronBinary() : process.execPath
  const env = { ...process.env, __PROBE_PKG: pkgEntry }
  if (target === "electron") env.ELECTRON_RUN_AS_NODE = "1"
  const res = spawnSync(cmd, ["-e", snippet], { env, encoding: "utf8" })
  return (res.stdout || "").trim() === "ok"
}

/**
 * Ensure better-sqlite3 works under `target`'s runtime.
 *
 * better-sqlite3 v13+ (and node-pty) are N-API (node-addon-api): a single
 * prebuilt binary loads on ANY Node/Electron ABI, so no per-ABI swap is needed —
 * if the package already loads, this is a no-op. The legacy node-gyp swap below
 * is kept as a fallback for a pre-v13 (ABI-specific) binary.
 * @param {"node"|"electron"} target
 */
function ensureAbi(target) {
  const label = target === "node" ? "Node (test)" : "Electron (app)"

  // Fast path: N-API / already-correct binary loads as-is → nothing to swap.
  if (moduleLoadsUnder(target)) {
    console.log(`native ABI — ${label}: better-sqlite3 loads as-is (N-API), no swap needed`)
    return
  }

  // --- Legacy node-gyp ABI swap (pre-v13 better-sqlite3) --------------------
  const bin = betterSqlite3Bin()

  // 1) Already correct? Make sure it's cached, then stop.
  const current = probe(target, bin)
  if (current.loads) {
    saveToCache(bin, current.abi)
    console.log(`native ABI — ${label} already in place (ABI ${current.abi})`)
    return
  }

  // The probe reports the consuming runtime's ABI even when the load failed — that's
  // the ABI we need to install and the cache slot to look in.
  const targetAbi = current.abi
  const cached = cachePathFor(targetAbi)

  // 2) Cache hit → copy in and re-verify (fast path, no build).
  if (existsSync(cached)) {
    copyFileSync(cached, bin)
    if (probe(target, bin).loads) {
      console.log(`native ABI — ${label} restored from cache (ABI ${targetAbi})`)
      return
    }
    console.warn(`native ABI — cached ABI ${targetAbi} binary did not load; rebuilding`)
  }

  // 3) Build once, verify, cache.
  build(target)
  const after = probe(target, bin)
  if (!after.loads) {
    throw new Error(`native ABI — ${target} build did not produce a loadable binary`)
  }
  saveToCache(bin, after.abi)
  console.log(`native ABI — ${label} built and cached (ABI ${after.abi})`)
}

module.exports = { ensureAbi }
