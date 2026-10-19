// @ts-check
const { spawnSync } = require("node:child_process")
const {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require("node:fs")
const { join } = require("node:path")
const { randomUUID } = require("node:crypto")
const { setTimeout: delay } = require("node:timers/promises")
const { APPLICATIONS_DIR } = require("./install-applications.cjs")
const {
  assertPackageOutputIdle,
  runningPackageOutputPids,
} = require("./assert-package-output-idle.cjs")

const DESKTOP_DIR = join(__dirname, "..")

/** Claim the shared `out/` and icon build inputs until packaging finishes. */
function acquireBuildLock(releaseRoot, channel) {
  mkdirSync(releaseRoot, { recursive: true })
  const lock = join(releaseRoot, ".package.lock")
  try {
    mkdirSync(lock)
  } catch (error) {
    if (error.code !== "EEXIST") throw error
    throw new Error(
      `PI Lab is already being packaged (${lock}). If an earlier build crashed, check that no package process is running before removing this lock.`,
    )
  }
  writeFileSync(join(lock, "owner"), `${channel} PID ${process.pid}\n`)
  return () => rmSync(lock, { recursive: true, force: true })
}

/** The packaged identities used by Finder and the running app. */
function channelDefinition(value) {
  const channel = value || "alpha"
  if (channel === "alpha")
    return { channel, productName: "PI Lab Alpha", appId: "com.pi-lab.desktop.alpha" }
  if (channel === "stable") return { channel, productName: "PI Lab", appId: "com.pi-lab.desktop" }
  throw new Error(`Unknown PI Lab channel: ${channel}`)
}

/** The Finder-visible alias for one channel's current macOS app. */
function bundleAlias(channel, productName) {
  return join(DESKTOP_DIR, "release", channel, "mac-arm64", `${productName}.app`)
}

/**
 * Move a completed package to an immutable path, then atomically point the
 * channel alias at it. A process launched through the alias resolves to the
 * immutable bundle, so switching the alias never changes its app.asar.
 */
function activateStagedBuild(channelRoot, buildId, productName) {
  const appSubpath = join("mac-arm64", `${productName}.app`)
  const stage = join(channelRoot, ".staging", buildId)
  const stagedApp = join(stage, appSubpath)
  if (!existsSync(stagedApp)) throw new Error(`Packaged app is missing: ${stagedApp}`)
  const alias = join(channelRoot, appSubpath)
  if (existsSync(alias) && !lstatSync(alias).isSymbolicLink()) {
    throw new Error(`Refusing to replace a non-channel bundle: ${alias}`)
  }
  const build = join(channelRoot, "builds", buildId)
  mkdirSync(join(channelRoot, "builds"), { recursive: true })
  mkdirSync(join(channelRoot, "mac-arm64"), { recursive: true })
  renameSync(stage, build)
  const nextAlias = `${alias}.next-${randomUUID()}`
  symlinkSync(join("..", "builds", buildId, appSubpath), nextAlias)
  renameSync(nextAlias, alias)

  // Installer output is immutable too. Keep a convenient channel-level alias.
  for (const file of readdirSync(build)) {
    if (!file.endsWith(".dmg")) continue
    const dmgAlias = join(channelRoot, file)
    const nextDmgAlias = `${dmgAlias}.next-${randomUUID()}`
    symlinkSync(join("builds", buildId, file), nextDmgAlias)
    renameSync(nextDmgAlias, dmgAlias)
  }
  return alias
}

/** Execute one packaging step and stop on its first failure. */
function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: DESKTOP_DIR, env, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})`)
}

/** Compile and package for the selected channel, using the builder output from env. */
function runBuildSteps(env, production, publishMode) {
  run("bun", ["run", "build:icons"], env)
  run("bun", ["run", "build"], env)
  run("bun", ["run", "validate:package"], env)
  run("bun", ["run", "setup:native"], env)
  run("bun", ["run", "validate:native"], env)
  run(
    "bun",
    [
      "run",
      "electron-builder",
      "--config",
      "electron-builder.config.cjs",
      ...(production ? [] : ["--dir"]),
      ...(publishMode ? ["--publish", publishMode] : []),
    ],
    env,
  )
}

/** Wait for an app bundle to quit before changing files at its launch path. */
async function waitForTargetToClose(bundle) {
  let announced = false
  while (true) {
    const pids = runningPackageOutputPids(bundle)
    if (pids.length === 0) return
    if (!announced) {
      process.stdout.write(
        `Build complete. Waiting for ${bundle} (PID ${pids.join(", ")}) to quit before replacing it.\n`,
      )
      announced = true
    }
    await delay(1000)
  }
}

/** Package one channel while its caller owns the shared release build lock. */
async function packageChannelWithLockHeld(value, production) {
  const { channel, productName } = channelDefinition(value)
  const releaseRoot = join(DESKTOP_DIR, "release")
  if (process.platform !== "darwin") {
    runBuildSteps({ ...process.env, PI_LAB_CHANNEL: channel }, production, null)
    return
  }
  const alias = bundleAlias(channel, productName)
  const applicationsApp = join(APPLICATIONS_DIR, `${productName}.app`)
  const applicationsLink =
    channel !== "stable" &&
    lstatSync(applicationsApp, { throwIfNoEntry: false })?.isSymbolicLink() &&
    readlinkSync(applicationsApp) === alias
  const root = join(releaseRoot, channel)
  const buildId = `${Date.now()}-${process.pid}-${randomUUID()}`
  const stage = join(root, ".staging", buildId)
  try {
    assertPackageOutputIdle(alias)
    if (applicationsLink) assertPackageOutputIdle(applicationsApp)
    mkdirSync(stage, { recursive: true })
    const env = { ...process.env, PI_LAB_CHANNEL: channel, PI_LAB_PACKAGE_STAGE: stage }
    runBuildSteps(env, production, null)

    await waitForTargetToClose(alias)
    if (applicationsLink) await waitForTargetToClose(applicationsApp)
    const active = activateStagedBuild(root, buildId, productName)
    process.stdout.write(`Packaged ${channel}: ${active}\n`)
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    throw error
  }
}

/** Package one channel without ever writing into its running app bundle. */
async function packageChannel(value, production) {
  const releaseLock = acquireBuildLock(
    join(DESKTOP_DIR, "release"),
    channelDefinition(value).channel,
  )
  try {
    await packageChannelWithLockHeld(value, production)
  } finally {
    releaseLock()
  }
}

if (require.main === module) {
  packageChannel(process.argv[2], process.argv[3] === "prod").catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = {
  acquireBuildLock,
  activateStagedBuild,
  bundleAlias,
  channelDefinition,
  packageChannel,
  packageChannelWithLockHeld,
  runBuildSteps,
}
