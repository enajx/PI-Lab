#!/usr/bin/env node
// @ts-check
/**
 * Validate actual native loading under the consuming Node or Electron runtime.
 * Default mode opens an in-memory SQLite database and loads the PTY addons from
 * the checkout. --app loads the target binaries from app.asar.unpacked using the
 * packages' current layouts. Packaged SQLite and terminal smoke tests also prove
 * the full JS resolver and daemon path in the real app.
 */

const { existsSync, readdirSync, statSync } = require("node:fs")
const { join, resolve } = require("node:path")

const ABI = process.versions.modules
const RUNTIME = process.versions.electron ? `Electron ${process.versions.electron}` : "Node"
const DESKTOP_DIR = join(__dirname, "..")

/** @returns {string|null} Parse the optional packaged-app path. */
function parseAppArg() {
  const i = process.argv.indexOf("--app")
  return i !== -1 && process.argv[i + 1] ? resolve(process.cwd(), process.argv[i + 1]) : null
}

/** @param {string} appPath @returns {string[]} Find unpacked native directories. */
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

/** @param {string[]} fromPaths Open and query SQLite through its package. */
function checkBetterSqlite3(fromPaths) {
  const Database = require(require.resolve("better-sqlite3", { paths: fromPaths }))
  const db = new Database(":memory:")
  const row = db.prepare("select 1 as x").get()
  db.close()
  if (row?.x !== 1) throw new Error("better-sqlite3 query returned unexpected result")
}

/** @param {string[]} fromPaths Load PTY addons and required helper files. */
function checkNodePty(fromPaths) {
  const ptyPath = require.resolve("node-pty", { paths: fromPaths })
  const pty = require(ptyPath)
  if (typeof pty.spawn !== "function") throw new Error("node-pty has no spawn()")
  checkPtyBinaries(resolve(ptyPath, "../.."))
}

/** @param {string} label @param {string[]} fromPaths Validate checkout dependencies. */
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
 * @param {string} moduleDir
 * @param {string[]} candidates
 * @returns {string} First existing binary in the runtime loader's order.
 */
function nativeBinary(moduleDir, candidates) {
  const found = candidates.map((candidate) => join(moduleDir, candidate)).find(existsSync)
  if (!found) throw new Error(`native binary missing under ${moduleDir}: ${candidates.join(", ")}`)
  return found
}

/** @param {string} moduleDir @returns {string} SQLite 13 prebuild or source-build path. */
function sqliteBinary(moduleDir) {
  const platform =
    process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime
      ? "linuxmusl"
      : process.platform
  return nativeBinary(moduleDir, [
    `prebuilds/${platform}-${process.arch}.node`,
    "build/Debug/better_sqlite3.node",
    "build/Release/better_sqlite3.node",
  ])
}

/** @param {string} moduleDir Load PTY binaries and verify their platform helpers. */
function checkPtyBinaries(moduleDir) {
  const names = process.platform === "win32" ? ["pty", "conpty", "conpty_console_list"] : ["pty"]
  for (const name of names) {
    const file = nativeBinary(moduleDir, [
      `build/Release/${name}.node`,
      `build/Debug/${name}.node`,
      `prebuilds/${process.platform}-${process.arch}/${name}.node`,
    ])
    require(file)
    const nativeDir = resolve(file, "..")
    if (process.platform === "darwin") {
      const helper = join(nativeDir, "spawn-helper")
      if (!existsSync(helper)) throw new Error(`spawn-helper missing at ${helper}`)
      if ((statSync(helper).mode & 0o111) !== 0o111) {
        throw new Error(`spawn-helper not executable: ${helper}`)
      }
    }
    if (process.platform === "win32") {
      const helpers =
        name === "pty"
          ? ["winpty.dll", "winpty-agent.exe"]
          : name === "conpty"
            ? ["conpty/conpty.dll", "conpty/OpenConsole.exe"]
            : []
      for (const helper of helpers) {
        const helperPath = join(nativeDir, helper)
        if (!existsSync(helperPath)) throw new Error(`PTY helper missing at ${helperPath}`)
      }
    }
  }
}

/** @param {string} appPath Load target native binaries from the packaged app. */
function runPackaged(appPath) {
  const unpacked = findUnpackedModules(appPath)
  if (unpacked.length === 0) {
    throw new Error(`no app.asar.unpacked/node_modules found under ${appPath}`)
  }
  for (const nm of unpacked) {
    console.log(`  packaged: ${nm}`)

    process.stdout.write("  • better-sqlite3 (.node) ... ")
    const sqliteNode = sqliteBinary(join(nm, "better-sqlite3"))
    require(sqliteNode) // throws on ABI mismatch
    process.stdout.write("ok\n")

    process.stdout.write("  • node-pty (.node + spawn-helper) ... ")
    checkPtyBinaries(join(nm, "node-pty"))
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
