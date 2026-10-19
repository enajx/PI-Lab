// @ts-check
const { execFileSync } = require("node:child_process")
const { existsSync, lstatSync, readlinkSync, realpathSync } = require("node:fs")
const { dirname, resolve } = require("node:path")

/** Return PIDs of user-facing PI Lab processes launched from this bundle. */
function runningBundlePids(processList, bundlePath) {
  const bundlePaths = [bundlePath]
  let target = bundlePath
  while (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    target = resolve(dirname(target), readlinkSync(target))
    if (bundlePaths.includes(target)) break
    bundlePaths.push(target)
  }
  if (existsSync(bundlePath)) bundlePaths.push(realpathSync(bundlePath))
  const binaries = bundlePaths.map(
    (path) =>
      `${path}/Contents/MacOS/${path
        .split("/")
        .pop()
        .replace(/\.app$/, "")}`,
  )
  const pids = []
  for (const line of processList.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match) continue
    const command = match[2]
    if (!binaries.some((binary) => command === binary || command.startsWith(`${binary} `))) continue
    if (command.includes("/out/pty-daemon/index.js")) continue
    pids.push(Number(match[1]))
  }
  return pids
}

/** Reject the current process list if this bundle is still in use. */
function assertBundleIdle(bundlePath, processList) {
  const pids = runningBundlePids(processList, bundlePath)
  if (pids.length > 0) {
    throw new Error(
      `PI Lab is running from ${bundlePath} (PID ${pids.join(", ")}). Quit it from the tray before packaging. Replacing its app.asar while it runs makes the window unusable.`,
    )
  }
}

/** Check the actual bundle targeted by electron-builder. */
function assertPackageOutputIdle(bundlePath) {
  if (process.platform !== "darwin") return
  const pids = runningPackageOutputPids(bundlePath)
  if (pids.length > 0) {
    throw new Error(
      `PI Lab is running from ${bundlePath} (PID ${pids.join(", ")}). Quit it from the tray before packaging. Replacing its app.asar while it runs makes the window unusable.`,
    )
  }
}

/** Inspect the current process list for the selected bundle. */
function runningPackageOutputPids(bundlePath) {
  if (process.platform !== "darwin") return []
  const processList = execFileSync("ps", ["-Aww", "-o", "pid=,command="], { encoding: "utf8" })
  return runningBundlePids(processList, bundlePath)
}

if (require.main === module) {
  const channel = process.env.PI_LAB_CHANNEL || "alpha"
  if (channel !== "alpha" && channel !== "stable") {
    throw new Error(`Unknown local PI Lab channel: ${channel}`)
  }
  const product = channel === "stable" ? "PI Lab" : "PI Lab Alpha"
  assertPackageOutputIdle(resolve(__dirname, `../release/${channel}/mac-arm64/${product}.app`))
}

module.exports = {
  assertBundleIdle,
  assertPackageOutputIdle,
  runningBundlePids,
  runningPackageOutputPids,
}
