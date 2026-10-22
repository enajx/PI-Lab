// @ts-check
const { execFileSync, spawnSync } = require("node:child_process")
const { existsSync, lstatSync, readdirSync, rmSync } = require("node:fs")
const { join } = require("node:path")
const { acquireBuildLock, packageChannelWithLockHeld } = require("./package-channel.cjs")
const { runningBundlePids } = require("./assert-package-output-idle.cjs")

const DESKTOP_DIR = join(__dirname, "..")
const REPO_ROOT = join(DESKTOP_DIR, "..", "..")
const RELEASE_ROOT = join(DESKTOP_DIR, "release")

/** Remove generated local Stable packages only when none of their apps run. */
function cleanStableBuilds(releaseRoot, processList) {
  const stableRoot = join(releaseRoot, "stable")
  if (!existsSync(stableRoot)) return false
  const rootInfo = lstatSync(stableRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Refusing to clean a non-directory Stable output: ${stableRoot}`)
  }
  for (const entry of readdirSync(stableRoot, { withFileTypes: true })) {
    const generatedDirectory = [".staging", "builds", "mac-arm64"].includes(entry.name)
    const generatedDmgLink = entry.name.endsWith(".dmg") && entry.isSymbolicLink()
    if (!(generatedDirectory && entry.isDirectory()) && !generatedDmgLink) {
      throw new Error(`Refusing to clean unexpected Stable output: ${join(stableRoot, entry.name)}`)
    }
  }
  const bundles = [join(stableRoot, "mac-arm64", "PI Lab.app")]
  const builds = join(stableRoot, "builds")
  if (existsSync(builds)) {
    for (const build of readdirSync(builds, { withFileTypes: true })) {
      if (!build.isDirectory()) {
        throw new Error(`Refusing to clean unexpected Stable build: ${join(builds, build.name)}`)
      }
      bundles.push(join(builds, build.name, "mac-arm64", "PI Lab.app"))
    }
  }
  for (const bundle of bundles) {
    const pids = runningBundlePids(processList, bundle)
    if (pids.length > 0) {
      throw new Error(`Stable test app is still running from ${bundle} (PID ${pids.join(", ")})`)
    }
  }
  rmSync(stableRoot, { recursive: true })
  return true
}

/** Run a command and surface its failure before deleting any test package. */
function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})`)
}

/** Keep other packaging out while this Stable build is tested and cleaned. */
async function runStablePackageWorkflow(releaseRoot, packageBuild, verifyBuild, getProcessList) {
  const unlock = acquireBuildLock(releaseRoot, "stable-test")
  try {
    await packageBuild()
    verifyBuild()
    cleanStableBuilds(releaseRoot, getProcessList())
  } finally {
    unlock()
  }
}

/** Package Stable, check the real app, then clear its local test output. */
async function testStablePackage() {
  if (process.platform !== "darwin") throw new Error("Stable package smoke tests require macOS")
  const binary = join(
    RELEASE_ROOT,
    "stable",
    "mac-arm64",
    "PI Lab.app",
    "Contents",
    "MacOS",
    "PI Lab",
  )
  try {
    await runStablePackageWorkflow(
      RELEASE_ROOT,
      () => packageChannelWithLockHeld("stable", false),
      () =>
        run(
          process.execPath,
          [
            join(REPO_ROOT, "node_modules", "@playwright", "test", "cli.js"),
            "test",
            "tests/e2e/packaged-smoke.spec.ts",
          ],
          REPO_ROOT,
          {
            ...process.env,
            PI_LAB_PACKAGED_BINARY: binary,
            PI_LAB_EXPECTED_CHANNEL_NAME: "PI Lab",
          },
        ),
      () =>
        execFileSync("ps", ["-Aww", "-o", "pid=,command="], {
          encoding: "utf8",
        }),
    )
  } catch (error) {
    if (existsSync(binary)) {
      process.stderr.write(`Stable test build kept for inspection: ${binary}\n`)
    }
    throw error
  }
  process.stdout.write("Stable packaged tests passed; local Stable builds removed.\n")
}

if (require.main === module) {
  testStablePackage().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = { cleanStableBuilds, runStablePackageWorkflow, testStablePackage }
