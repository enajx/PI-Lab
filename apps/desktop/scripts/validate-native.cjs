#!/usr/bin/env node
// @ts-check
/**
 * Validate that the desktop's native modules are present and loadable under the
 * Electron ABI (AGENTS.md §12.4). Native-module ABI mismatches fail at *runtime*,
 * not at build time, so this is a hard gate before/after packaging: it loads each
 * `.node` addon the way the app does and exits nonzero (loudly) on any failure.
 *
 * Two run modes:
 *   - default (no arg): validate the modules resolved from `apps/desktop`
 *     (the rebuilt-in-place store copies). Used by `build:local` after
 *     `@electron/rebuild`, before electron-builder packs.
 *   - `--app <path-to-.app-or-appOutDir>`: validate the `.node` binaries INSIDE a
 *     packaged app's `app.asar.unpacked/node_modules`, proving the unpacked native
 *     addons ship + load under the Electron ABI. (We load the `.node` files
 *     directly rather than the full JS module: in the package the modules' pure-JS
 *     halves + their deps like `bindings` live inside `app.asar`, reachable only
 *     via Electron's asar-aware resolver in the real app — the running-app smoke
 *     test, `e2e/packaged-smoke.spec.ts`, covers that path end to end.)
 *
 * MUST be run with Electron's `ELECTRON_RUN_AS_NODE=1` (so `process.versions.modules`
 * is Electron's ABI). The build scripts invoke it that way; running under plain Node
 * validates the Node ABI instead (which is what `bun run test` needs) — the script
 * reports whichever runtime it's under so the caller can tell.
 */

const { existsSync, readdirSync, statSync } = require("node:fs")
const { join, resolve } = require("node:path")

const ABI = process.versions.modules
const RUNTIME = process.versions.electron ? `Electron ${process.versions.electron}` : "Node"
const DESKTOP_DIR = join(__dirname, "..")

/** Parse `--app <path>` if present (resolved to absolute — require() needs it). */
function parseAppArg() {
  const i = process.argv.indexOf("--app")
  return i !== -1 && process.argv[i + 1] ? resolve(process.cwd(), process.argv[i + 1]) : null
}

/** Find an `app.asar.unpacked/node_modules` dir under a packaged app/out dir. */
function findUnpackedModules(appPath) {
  /** @type {string[]} */
  const found = []
  /** @param {string} dir @param {number} depth */
  function walk(dir, depth) {
    if (depth > 6 || !existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name === "app.asar.unpacked") {
        const nm = join(dir, entry.name, "node_modules")
        if (existsSync(nm)) found.push(nm)
        continue
      }
      walk(join(dir, entry.name), depth + 1)
    }
  }
  walk(appPath, 0)
  return found
}

/** Load + smoke-test better-sqlite3 from a base resolution path. */
function checkBetterSqlite3(fromPaths) {
  const Database = require(require.resolve("better-sqlite3", { paths: fromPaths }))
  const db = new Database(":memory:")
  const row = db.prepare("select 1 as x").get()
  db.close()
  if (row?.x !== 1) throw new Error("better-sqlite3 query returned unexpected result")
}

/** Load + smoke-test node-pty (and assert its spawn-helper is executable). */
function checkNodePty(fromPaths) {
  const ptyPath = require.resolve("node-pty", { paths: fromPaths })
  const pty = require(ptyPath)
  if (typeof pty.spawn !== "function") throw new Error("node-pty has no spawn()")
  // spawn-helper must exist and be executable on POSIX (node-pty exec()s it).
  if (process.platform !== "win32") {
    const moduleDir = join(ptyPath, "..", "..") // lib/index.js → node-pty/
    const helper = join(moduleDir, "build", "Release", "spawn-helper")
    if (!existsSync(helper)) throw new Error(`spawn-helper missing at ${helper}`)
    const mode = statSync(helper).mode
    if ((mode & 0o111) === 0) throw new Error(`spawn-helper not executable: ${helper}`)
  }
}

function run(label, fromPaths) {
  const checks = [
    ["better-sqlite3", () => checkBetterSqlite3(fromPaths)],
    ["node-pty", () => checkNodePty(fromPaths)],
  ]
  for (const [name, fn] of checks) {
    process.stdout.write(`  • ${name} ... `)
    fn()
    process.stdout.write("ok\n")
  }
  console.log(`validate:native — ${label} OK (runtime: ${RUNTIME}, module ABI ${ABI})`)
}

/**
 * Validate the packaged app's unpacked native addons by loading the raw `.node`
 * binaries directly (asserting Electron-ABI compatibility) and checking the
 * node-pty spawn-helper is executable.
 */
function runPackaged(appPath) {
  const unpacked = findUnpackedModules(appPath)
  if (unpacked.length === 0) {
    throw new Error(`no app.asar.unpacked/node_modules found under ${appPath}`)
  }
  for (const nm of unpacked) {
    console.log(`  packaged: ${nm}`)

    process.stdout.write("  • better-sqlite3 (.node) ... ")
    const sqliteNode = join(nm, "better-sqlite3", "build", "Release", "better_sqlite3.node")
    if (!existsSync(sqliteNode)) throw new Error(`missing ${sqliteNode}`)
    require(sqliteNode) // throws on ABI mismatch
    process.stdout.write("ok\n")

    process.stdout.write("  • node-pty (.node + spawn-helper) ... ")
    const ptyNode = join(nm, "node-pty", "build", "Release", "pty.node")
    if (!existsSync(ptyNode)) throw new Error(`missing ${ptyNode}`)
    require(ptyNode) // throws on ABI mismatch
    if (process.platform !== "win32") {
      const helper = join(nm, "node-pty", "build", "Release", "spawn-helper")
      if (!existsSync(helper)) throw new Error(`spawn-helper missing at ${helper}`)
      if ((statSync(helper).mode & 0o111) === 0) {
        throw new Error(`spawn-helper not executable: ${helper}`)
      }
    }
    process.stdout.write("ok\n")
  }
  console.log(`validate:native — packaged OK (runtime: ${RUNTIME}, module ABI ${ABI})`)
}

function main() {
  const appPath = parseAppArg()
  if (appPath) {
    runPackaged(appPath)
    return
  }
  run("project node_modules", [DESKTOP_DIR])
}

try {
  main()
} catch (err) {
  console.error(`\nvalidate:native FAILED (runtime: ${RUNTIME}, module ABI ${ABI}):`)
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
