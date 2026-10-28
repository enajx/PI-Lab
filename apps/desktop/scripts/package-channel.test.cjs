const assert = require("node:assert/strict")
const {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} = require("node:fs")
const { test } = require("node:test")
const { tmpdir } = require("node:os")
const { join } = require("node:path")
const {
  channelDefinition,
  activateStagedBuild,
  acquireBuildLock,
} = require("./package-channel.cjs")

test("each channel has its own bundle path, with Alpha as the default", () => {
  assert.deepEqual(channelDefinition(undefined), {
    channel: "alpha",
    productName: "PI Lab Alpha",
    appId: "com.pi-lab.desktop.alpha",
  })
  assert.throws(() => channelDefinition("beta"), /Unknown PI Lab channel/)
  assert.deepEqual(channelDefinition("stable"), {
    channel: "stable",
    productName: "PI Lab",
    appId: "com.pi-lab.desktop",
  })
  assert.throws(() => channelDefinition("nightly"), /Unknown PI Lab channel/)
})

test("promoting a build switches the alias without changing the old bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-lab-package-promotion-"))
  try {
    const stageOne = join(root, ".staging", "one")
    const stageTwo = join(root, ".staging", "two")
    const appSubpath = join("mac-arm64", "PI Lab Alpha.app")
    mkdirSync(join(stageOne, appSubpath), { recursive: true })
    mkdirSync(join(stageTwo, appSubpath), { recursive: true })
    writeFileSync(join(stageOne, appSubpath, "version"), "one")
    writeFileSync(join(stageTwo, appSubpath, "version"), "two")

    const first = activateStagedBuild(root, "one", "PI Lab Alpha")
    const alias = join(root, appSubpath)
    assert.equal(first, alias)
    assert.equal(readlinkSync(alias), join("..", "builds", "one", appSubpath))
    assert.equal(existsSync(join(root, "builds", "one", appSubpath, "version")), true)

    activateStagedBuild(root, "two", "PI Lab Alpha")
    assert.equal(readlinkSync(alias), join("..", "builds", "two", appSubpath))
    assert.equal(existsSync(join(root, "builds", "one", appSubpath, "version")), true)
    assert.equal(existsSync(join(root, "builds", "two", appSubpath, "version")), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("one packaging process owns the shared build output at a time", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-lab-package-lock-"))
  try {
    const releaseAlpha = acquireBuildLock(root, "alpha")
    assert.throws(() => acquireBuildLock(root, "alpha"), /already being packaged/)
    assert.throws(() => acquireBuildLock(root, "beta"), /already being packaged/)
    releaseAlpha()
    const releaseAgain = acquireBuildLock(root, "beta")
    releaseAgain()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("builder metadata and direct output stay channel-specific", () => {
  const previousChannel = process.env.PI_LAB_CHANNEL
  const previousStage = process.env.PI_LAB_PACKAGE_STAGE
  const previousBuild = process.env.PI_LAB_BUILD_ID
  process.env.PI_LAB_BUILD_ID = "one-packaged-build"
  delete process.env.PI_LAB_PACKAGE_STAGE
  try {
    for (const channel of ["alpha", "stable"]) {
      process.env.PI_LAB_CHANNEL = channel
      const configPath = require.resolve("../electron-builder.config.cjs")
      delete require.cache[configPath]
      const config = require(configPath)
      const identity = channelDefinition(channel)
      assert.equal(config.appId, identity.appId)
      assert.equal(config.productName, identity.productName)
      assert.equal(config.extraMetadata.piLabChannel, channel)
      assert.equal(
        config.extraMetadata.piLabBuildId,
        channel === "alpha" ? "one-packaged-build" : undefined,
      )
      assert.equal(config.directories.output, `release/.direct-${channel}`)
      assert.equal(config.fileAssociations.length > 0, channel === "stable")
      assert.equal(Boolean(config.mac.extendInfo.CFBundleDocumentTypes), channel === "stable")
      assert.equal(config.mac.extendInfo.CFBundleIconName, "AppIcon")
      assert.ok(
        config.mac.extraResources.some(
          (entry) => entry.from === "build/Assets.car" && entry.to === "Assets.car",
        ),
      )
      assert.deepEqual(config.mac.signIgnore, [
        "/Resources/app-icon-(?:channel-)?variants/.*\\.png$",
      ])
    }
  } finally {
    if (previousChannel === undefined) delete process.env.PI_LAB_CHANNEL
    else process.env.PI_LAB_CHANNEL = previousChannel
    if (previousStage === undefined) delete process.env.PI_LAB_PACKAGE_STAGE
    else process.env.PI_LAB_PACKAGE_STAGE = previousStage
    if (previousBuild === undefined) delete process.env.PI_LAB_BUILD_ID
    else process.env.PI_LAB_BUILD_ID = previousBuild
  }
})

test("direct Alpha packaging creates one distinct build ID per invocation", () => {
  const previousChannel = process.env.PI_LAB_CHANNEL
  const previousBuild = process.env.PI_LAB_BUILD_ID
  process.env.PI_LAB_CHANNEL = "alpha"
  delete process.env.PI_LAB_BUILD_ID
  const configPath = require.resolve("../electron-builder.config.cjs")
  try {
    delete require.cache[configPath]
    const first = require(configPath).extraMetadata.piLabBuildId
    assert.equal(typeof first, "string")
    assert.ok(first.length > 0)
    assert.equal(require(configPath).extraMetadata.piLabBuildId, first)
    delete require.cache[configPath]
    assert.notEqual(require(configPath).extraMetadata.piLabBuildId, first)
  } finally {
    if (previousChannel === undefined) delete process.env.PI_LAB_CHANNEL
    else process.env.PI_LAB_CHANNEL = previousChannel
    if (previousBuild === undefined) delete process.env.PI_LAB_BUILD_ID
    else process.env.PI_LAB_BUILD_ID = previousBuild
    delete require.cache[configPath]
  }
})
