#!/usr/bin/env node
// @ts-check
/**
 * Build the PI Lab server bundle for machines without the desktop app:
 * `release/server/pi-lab-server-<version>-darwin-<arch>.tar.gz` plus a
 * `.sha256` file. Usage: `node scripts/package-server-bundle.cjs <version>`,
 * after `bun run build` (it packs the built `out/`). Host arch only, macOS
 * only (Linux comes in step 3).
 *
 * Layout inside the archive (`pi-lab-server-<version>-darwin-<arch>/`):
 *   bin/pi-lab-server   launcher: `serve` and `enroll --name <client name>`
 *   node/bin/node       official Node binary, same version as Electron's Node
 *   app/out/main/       server.js, enroll.js, the preview worker, their chunks, drizzle/
 *   app/out/pty-daemon/ the PTY daemon
 *   app/node_modules/   the npm packages those files require, with their dependencies
 *   app/resources/skills/ bundled skills (LaTeX and dictation are left out)
 */

const { execFileSync } = require("node:child_process")
const { createHash } = require("node:crypto")
const {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs")
const { builtinModules, createRequire } = require("node:module")
const { dirname, join, relative } = require("node:path")

/** @typedef {"arm64" | "x64"} Arch */

const DESKTOP_DIR = join(__dirname, "..")
const OUT_DIR = join(DESKTOP_DIR, "out")
const RELEASE_DIR = join(DESKTOP_DIR, "release", "server")
const CACHE_DIR = join(RELEASE_DIR, "cache")

/** Electron 42's Node. Keep equal to `process.versions.node` under ELECTRON_RUN_AS_NODE. */
const NODE_VERSION = "24.19.0"
/**
 * SHA-256 of the official archives, from nodejs.org `SHASUMS256.txt`.
 * @type {Record<Arch, string>}
 */
const NODE_SHA256 = {
  arm64: "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d",
  x64: "d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316",
}

/** Entry files the bundle runs; their relative requires are followed. */
const ENTRIES = [
  "main/server.js",
  "main/enroll.js",
  "main/analysisPreviewWorker.js",
  "pty-daemon/index.js",
]

/**
 * Native packages: only the files they load at runtime are copied.
 * `{arch}` is the target arch.
 * @type {Record<string, string[]>}
 */
const NATIVE_FILES = {
  "better-sqlite3": ["package.json", "LICENSE", "lib", "prebuilds/darwin-{arch}.node"],
  "node-pty": [
    "package.json",
    "LICENSE",
    "lib",
    "build/Release/pty.node",
    "build/Release/spawn-helper",
  ],
  "@pi-lab/pty-termios": ["package.json", "index.cjs", "build/Release/pty_termios.node"],
}

/** @param {string} file */
function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

/**
 * Download (once, into the cache) and check the pinned Node archive.
 * @param {Arch} arch
 * @returns {string} The unpacked Node folder.
 */
function nodeBinary(arch) {
  const name = `node-v${NODE_VERSION}-darwin-${arch}`
  const archive = join(CACHE_DIR, `${name}.tar.gz`)
  mkdirSync(CACHE_DIR, { recursive: true })
  if (!existsSync(archive)) {
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.gz`
    console.error(`server bundle: downloading ${url}`)
    execFileSync("/usr/bin/curl", ["-fsSL", "-o", `${archive}.part`, url], { stdio: "inherit" })
    renameSync(`${archive}.part`, archive)
  }
  const actual = sha256(archive)
  if (actual !== NODE_SHA256[arch]) {
    rmSync(archive)
    throw new Error(
      `server bundle: ${archive} has SHA-256 ${actual}, expected ${NODE_SHA256[arch]}`,
    )
  }
  const unpacked = join(CACHE_DIR, name)
  if (!existsSync(join(unpacked, "bin", "node"))) {
    execFileSync("/usr/bin/tar", ["-xzf", archive, "-C", CACHE_DIR])
  }
  return unpacked
}

/**
 * Bare package specifiers and relative requires in one built file.
 * @param {string} file
 * @returns {string[]}
 */
function requiresOf(file) {
  const text = readFileSync(file, "utf8")
  /** @type {Set<string>} */
  const found = new Set()
  for (const match of text.matchAll(/(?:require|import)\(\s*["']([^"']+)["']\s*\)/g)) {
    if (match[1]) found.add(match[1])
  }
  return [...found]
}

/**
 * The package name of a bare specifier (`@scope/name/sub` → `@scope/name`).
 * @param {string} specifier
 */
function packageName(specifier) {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]
}

/** Every built file the entries reach, and the npm packages they require. */
function builtFilesAndPackages() {
  /** @type {Set<string>} */
  const files = new Set()
  /** @type {Set<string>} */
  const packages = new Set()
  const queue = ENTRIES.map((entry) => join(OUT_DIR, entry))
  while (queue.length > 0) {
    const file = queue.pop()
    if (!file || files.has(file)) continue
    if (!existsSync(file)) throw new Error(`server bundle: missing ${file}; run the build first`)
    files.add(file)
    for (const specifier of requiresOf(file)) {
      if (specifier.startsWith(".")) {
        queue.push(join(dirname(file), specifier))
      } else if (!specifier.startsWith("node:") && !builtinModules.includes(specifier)) {
        packages.add(packageName(specifier))
      }
    }
  }
  return { files: [...files], packages: [...packages] }
}

/**
 * The directory of package `name` as Node resolves it from `fromDir`.
 * @param {string} name
 * @param {string} fromDir
 */
function packageDir(name, fromDir) {
  const require2 = createRequire(join(fromDir, "noop.js"))
  for (const dir of require2.resolve.paths(name) ?? []) {
    const candidate = join(dir, name)
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate)
  }
  throw new Error(`server bundle: cannot find package ${name} from ${fromDir}`)
}

/**
 * Copy one package's runtime files into `dest`.
 * @param {string} name
 * @param {string} sourceDir
 * @param {string} dest
 * @param {Arch} arch
 */
function copyPackage(name, sourceDir, dest, arch) {
  mkdirSync(dest, { recursive: true })
  const native = NATIVE_FILES[name]
  if (!native) {
    cpSync(sourceDir, dest, {
      recursive: true,
      dereference: true,
      filter: (path) => !relative(sourceDir, path).split("/").includes("node_modules"),
    })
    return
  }
  for (const entry of native) {
    const path = entry.replace("{arch}", arch)
    const from = join(sourceDir, path)
    if (!existsSync(from)) throw new Error(`server bundle: ${name} has no ${path}`)
    mkdirSync(dirname(join(dest, path)), { recursive: true })
    cpSync(from, join(dest, path), { recursive: true, dereference: true })
  }
}

/**
 * Copy `names` (required from `fromDir`) and their dependencies into
 * `app/node_modules`. A package goes to the top level, or next to the package
 * that needs it when the top level already holds another version.
 * @param {string[]} names
 * @param {string} fromDir
 * @param {string} appDir
 * @param {Arch} arch
 */
function copyPackages(names, fromDir, appDir, arch) {
  /** @type {Map<string, string>} top-level name → version */
  const topLevel = new Map()
  /** @type {Array<{ name: string, fromDir: string, parentDest: string }>} */
  const queue = names.map((name) => ({ name, fromDir, parentDest: appDir }))
  /** @type {Set<string>} */
  const done = new Set()
  while (queue.length > 0) {
    const item = queue.shift()
    if (!item) break
    const sourceDir = packageDir(item.name, item.fromDir)
    const manifest = JSON.parse(readFileSync(join(sourceDir, "package.json"), "utf8"))
    const existing = topLevel.get(item.name)
    let dest
    if (existing === undefined) {
      topLevel.set(item.name, manifest.version)
      dest = join(appDir, "node_modules", item.name)
    } else if (existing === manifest.version) {
      continue
    } else {
      dest = join(item.parentDest, "node_modules", item.name)
    }
    if (done.has(dest)) continue
    done.add(dest)
    copyPackage(item.name, sourceDir, dest, arch)
    const deps = { ...manifest.dependencies, ...manifest.optionalDependencies }
    for (const dep of Object.keys(deps)) {
      // An optional dependency that is not installed is skipped, as npm does.
      if (manifest.optionalDependencies?.[dep] && !canResolve(dep, sourceDir)) continue
      queue.push({ name: dep, fromDir: sourceDir, parentDest: dest })
    }
  }
}

/**
 * True when Node would find package `name` from `fromDir`.
 * @param {string} name
 * @param {string} fromDir
 */
function canResolve(name, fromDir) {
  return (createRequire(join(fromDir, "noop.js")).resolve.paths(name) ?? []).some((dir) =>
    existsSync(join(dir, name, "package.json")),
  )
}

/**
 * The launcher script; the build id and version are fixed at packaging time.
 * @param {string} build
 * @param {string} version
 */
function launcherScript(build, version) {
  return `#!/bin/sh
# PI Lab server bundle launcher.
#   pi-lab-server serve                        run the server (data folder: PI_LAB_DATA_DIR or ~/.pi-lab)
#   pi-lab-server enroll --name <client name>  print a new device token as JSON
set -eu
root=$(cd "$(dirname "$0")/.." && pwd -P)
node="$root/node/bin/node"
app="$root/app"
export PI_LAB_DATA_DIR="\${PI_LAB_DATA_DIR:-$HOME/.pi-lab}"
command="\${1:-}"
[ $# -gt 0 ] && shift
case "$command" in
  serve)
    export PI_LAB_CHANNEL=stable
    export PI_LAB_PROFILE_DIR="$PI_LAB_DATA_DIR"
    export PI_LAB_PACKAGED=1
    export PI_LAB_RESOURCES_DIR="$app/resources"
    export PI_LAB_BUILD=${build}
    export PI_LAB_VERSION=${version}
    mkdir -p "$PI_LAB_DATA_DIR"
    exec "$node" "$app/out/main/server.js" "$PI_LAB_DATA_DIR"
    ;;
  enroll)
    exec "$node" "$app/out/main/enroll.js" "$@"
    ;;
  *)
    echo "usage: pi-lab-server serve | pi-lab-server enroll --name <client name>" >&2
    exit 2
    ;;
esac
`
}

/**
 * Size of a folder in bytes.
 * @param {string} dir
 * @returns {number}
 */
function folderSize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    total += entry.isDirectory() ? folderSize(path) : statSync(path).size
  }
  return total
}

function main() {
  const version = process.argv[2]
  if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("usage: package-server-bundle.cjs <version>")
  }
  if (process.platform !== "darwin") {
    throw new Error("server bundle: macOS only for now (Linux comes in step 3)")
  }
  const arch = process.arch
  if (arch !== "arm64" && arch !== "x64") throw new Error(`server bundle: unsupported arch ${arch}`)

  const name = `pi-lab-server-${version}-darwin-${arch}`
  const stage = join(RELEASE_DIR, ".stage")
  const root = join(stage, name)
  rmSync(stage, { recursive: true, force: true })
  const appDir = join(root, "app")

  // Built files: the reachable ones, plus the migrations next to server.js.
  const { files, packages } = builtFilesAndPackages()
  for (const file of files) {
    const dest = join(appDir, "out", relative(OUT_DIR, file))
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(file, dest)
  }
  cpSync(join(OUT_DIR, "main", "drizzle"), join(appDir, "out", "main", "drizzle"), {
    recursive: true,
  })
  cpSync(
    join(OUT_DIR, "pty-daemon", "package.json"),
    join(appDir, "out", "pty-daemon", "package.json"),
  )

  copyPackages(packages, DESKTOP_DIR, appDir, arch)
  const helper = join(appDir, "node_modules", "node-pty", "build", "Release", "spawn-helper")
  chmodSync(helper, 0o755)

  cpSync(join(DESKTOP_DIR, "resources", "skills"), join(appDir, "resources", "skills"), {
    recursive: true,
  })

  const nodeDir = nodeBinary(arch)
  mkdirSync(join(root, "node", "bin"), { recursive: true })
  copyFileSync(join(nodeDir, "bin", "node"), join(root, "node", "bin", "node"))
  chmodSync(join(root, "node", "bin", "node"), 0o755)
  copyFileSync(join(nodeDir, "LICENSE"), join(root, "node", "LICENSE"))

  // Same build id as the desktop app computes for server.js (`serverBuildId`).
  const build = sha256(join(OUT_DIR, "main", "server.js")).slice(0, 16)
  mkdirSync(join(root, "bin"))
  writeFileSync(join(root, "bin", "pi-lab-server"), launcherScript(build, version), { mode: 0o755 })

  const tarball = join(RELEASE_DIR, `${name}.tar.gz`)
  execFileSync("/usr/bin/tar", ["-czf", tarball, "-C", stage, name], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  })
  writeFileSync(`${tarball}.sha256`, `${sha256(tarball)}  ${name}.tar.gz\n`)
  const unpackedMb = (folderSize(root) / 1024 / 1024).toFixed(1)
  const packedMb = (statSync(tarball).size / 1024 / 1024).toFixed(1)
  rmSync(stage, { recursive: true, force: true })
  console.error(`server bundle: ${packedMb} MB packed, ${unpackedMb} MB unpacked`)
  console.log(tarball)
}

main()
