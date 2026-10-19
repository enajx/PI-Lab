const assert = require("node:assert/strict")
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require("node:fs")
const { test } = require("node:test")
const { tmpdir } = require("node:os")
const { join } = require("node:path")
const {
  assertPublicReleaseCredentials,
  publicReleaseDefinition,
  publicUpdateUrl,
} = require("./public-release.cjs")
const { validatePackageDependencies } = require("./validate-package-dependencies.cjs")

test("public release tracks share the installed PI Lab identity", () => {
  assert.deepEqual(publicReleaseDefinition("stable", "1.2.3"), {
    channel: "stable",
    updaterChannel: "latest",
    iconChannel: "stable",
    version: "1.2.3",
    productName: "PI Lab",
    appId: "com.pi-lab.desktop",
  })
  assert.deepEqual(publicReleaseDefinition("beta", "1.3.0-beta.2"), {
    channel: "beta",
    updaterChannel: "beta",
    iconChannel: "beta",
    version: "1.3.0-beta.2",
    productName: "PI Lab",
    appId: "com.pi-lab.desktop",
  })
})

test("public release version must match its track", () => {
  assert.throws(() => publicReleaseDefinition("stable", "0.0.0"), /positive version/)
  assert.throws(() => publicReleaseDefinition("beta", "1.3.0"), /beta version/)
  assert.throws(
    () => publicReleaseDefinition("nightly", "1.3.0-alpha.20261016"),
    /Unknown public release channel/,
  )
  assert.throws(() => publicReleaseDefinition("other", "1.0.0"), /Unknown public release channel/)
})

test("public feeds use HTTPS except for isolated local updater tests", () => {
  assert.equal(
    publicUpdateUrl("https://example.test/updates/", false),
    "https://example.test/updates/",
  )
  assert.throws(() => publicUpdateUrl("http://example.test/updates/", true), /HTTPS/)
  assert.throws(() => publicUpdateUrl("http://127.0.0.1:8500/", false), /HTTPS/)
  assert.throws(() => publicUpdateUrl("https://example.test/updates/", true), /local feed/)
  assert.equal(publicUpdateUrl("http://127.0.0.1:8500/", true), "http://127.0.0.1:8500/")
  assert.equal(publicUpdateUrl("file:///tmp/pi-lab-feed/", true), "file:///tmp/pi-lab-feed/")
})

test("production public builds require notarization credentials", () => {
  assert.doesNotThrow(() => assertPublicReleaseCredentials({}, true))
  assert.throws(() => assertPublicReleaseCredentials({}, false), /notarization credentials/)
  assert.throws(
    () => assertPublicReleaseCredentials({ APPLE_KEYCHAIN_PROFILE: "pi-lab-notary" }, false),
    /notarization credentials/,
  )
  assert.doesNotThrow(() =>
    assertPublicReleaseCredentials(
      {
        APPLE_KEYCHAIN: "/Users/example/Library/Keychains/login.keychain-db",
        APPLE_KEYCHAIN_PROFILE: "pi-lab-notary",
      },
      false,
    ),
  )
  assert.doesNotThrow(() =>
    assertPublicReleaseCredentials(
      { APPLE_ID: "id", APPLE_APP_SPECIFIC_PASSWORD: "password", APPLE_TEAM_ID: "team" },
      false,
    ),
  )
})

test("production public builds use a Keychain signing identity and notarization profile", () => {
  const keys = [
    "PI_LAB_PUBLIC_RELEASE_CHANNEL",
    "PI_LAB_RELEASE_VERSION",
    "PI_LAB_UPDATE_URL",
    "PI_LAB_UPDATE_TEST_BUILD",
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "PI_LAB_FORCE_SIGN",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
    "APPLE_KEYCHAIN",
    "APPLE_KEYCHAIN_PROFILE",
  ]
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const configPath = require.resolve("../electron-builder.config.cjs")
  try {
    for (const key of keys) delete process.env[key]
    process.env.PI_LAB_PUBLIC_RELEASE_CHANNEL = "stable"
    process.env.PI_LAB_RELEASE_VERSION = "1.2.3"
    process.env.PI_LAB_UPDATE_URL = "https://updates.example.test/pi-lab/"
    process.env.APPLE_KEYCHAIN = "/Users/example/Library/Keychains/login.keychain-db"
    process.env.APPLE_KEYCHAIN_PROFILE = "pi-lab-notary"
    delete require.cache[configPath]
    const config = require(configPath)
    assert.equal(config.forceCodeSigning, true)
    assert.equal(config.mac.type, "distribution")
    assert.equal(config.mac.identity, undefined)
    assert.equal(config.mac.notarize, true)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    delete require.cache[configPath]
  }
})

test("public builder config generates mac update metadata and keeps local builds unchanged", () => {
  const previous = {
    release: process.env.PI_LAB_PUBLIC_RELEASE_CHANNEL,
    version: process.env.PI_LAB_RELEASE_VERSION,
    url: process.env.PI_LAB_UPDATE_URL,
    channel: process.env.PI_LAB_CHANNEL,
    testBuild: process.env.PI_LAB_UPDATE_TEST_BUILD,
  }
  const configPath = require.resolve("../electron-builder.config.cjs")
  try {
    for (const [channel, version, updaterChannel] of [
      ["stable", "1.2.3", "latest"],
      ["beta", "1.3.0-beta.2", "beta"],
    ]) {
      process.env.PI_LAB_PUBLIC_RELEASE_CHANNEL = channel
      process.env.PI_LAB_RELEASE_VERSION = version
      process.env.PI_LAB_UPDATE_URL = "http://127.0.0.1:8500/pi-lab/"
      process.env.PI_LAB_CHANNEL = "alpha"
      process.env.PI_LAB_UPDATE_TEST_BUILD = "1"
      delete require.cache[configPath]
      const config = require(configPath)
      assert.equal(config.appId, "com.pi-lab.desktop")
      assert.equal(config.productName, "PI Lab")
      assert.equal(config.extraMetadata.piLabChannel, "stable")
      assert.equal(config.extraMetadata.piLabPublicRelease, true)
      assert.equal(config.extraMetadata.piLabReleaseChannel, channel)
      assert.equal(config.extraMetadata.version, version)
      assert.deepEqual(
        config.mac.target.map((target) => target.target),
        ["dmg", "zip"],
      )
      assert.equal(config.publish.provider, "generic")
      assert.equal(config.publish.url, "http://127.0.0.1:8500/pi-lab/")
      assert.equal(config.publish.channel, updaterChannel)
      assert.equal(config.generateUpdatesFilesForAllChannels, false)
      assert.equal(config.forceCodeSigning, false)
      const iconVariants = config.extraResources.find((resource) =>
        ["app-icon-variants", "app-icon-channel-variants"].includes(resource.to),
      )
      assert.equal(
        iconVariants.to,
        channel === "stable" ? "app-icon-variants" : "app-icon-channel-variants",
      )
      const palettes = config.extraResources.find(
        (resource) => resource.to === "app-icon-palettes.json",
      )
      if (channel === "beta") {
        assert.equal(iconVariants.filter[0], "joyplot-*-beta*.png")
        assert.equal(palettes.from, "../../icons-temp/matplotlib-colormaps-3.11.2.json")
      } else {
        assert.equal(palettes, undefined)
      }
    }
    delete process.env.PI_LAB_PUBLIC_RELEASE_CHANNEL
    delete require.cache[configPath]
    const localConfig = require(configPath)
    assert.equal(localConfig.publish, null)
    assert.equal(localConfig.extraMetadata.piLabReleaseChannel, undefined)
    assert.deepEqual(
      localConfig.mac.target.map((target) => target.target),
      ["dmg", "dir"],
    )
    assert.equal(localConfig.extraMetadata.piLabPublicRelease, undefined)
  } finally {
    for (const [key, value] of Object.entries({
      PI_LAB_PUBLIC_RELEASE_CHANNEL: previous.release,
      PI_LAB_RELEASE_VERSION: previous.version,
      PI_LAB_UPDATE_URL: previous.url,
      PI_LAB_CHANNEL: previous.channel,
      PI_LAB_UPDATE_TEST_BUILD: previous.testBuild,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    delete require.cache[configPath]
  }
})

test("packaged runtime includes electron-updater and its required dependencies", () => {
  const output = mkdtempSync(join(tmpdir(), "pi-lab-updater-runtime-"))
  try {
    for (const name of ["main", "preload", "pty-daemon"]) {
      mkdirSync(join(output, name))
    }
    writeFileSync(join(output, "main", "index.js"), 'require("electron-updater")\n')
    const config = require("../electron-builder.config.cjs")
    validatePackageDependencies(output, config)
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})
