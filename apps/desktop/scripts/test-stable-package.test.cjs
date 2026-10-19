const assert = require("node:assert/strict")
const {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require("node:fs")
const { test } = require("node:test")
const { tmpdir } = require("node:os")
const { join } = require("node:path")
const { acquireBuildLock } = require("./package-channel.cjs")
const { cleanStableBuilds, runStablePackageWorkflow } = require("./test-stable-package.cjs")

test("cleaning a verified Stable test build removes only generated Stable output", () => {
  const release = mkdtempSync(join(tmpdir(), "pi-lab-stable-clean-"))
  try {
    const build = join(release, "stable", "builds", "one", "mac-arm64", "PI Lab.app")
    const aliasDir = join(release, "stable", "mac-arm64")
    mkdirSync(build, { recursive: true })
    mkdirSync(aliasDir, { recursive: true })
    writeFileSync(join(build, "version"), "test")
    symlinkSync(
      join("..", "builds", "one", "mac-arm64", "PI Lab.app"),
      join(aliasDir, "PI Lab.app"),
    )
    writeFileSync(join(release, "public-release"), "keep")

    assert.equal(cleanStableBuilds(release, ""), true)
    assert.equal(readFileSync(join(release, "public-release"), "utf8"), "keep")
    assert.throws(() => readFileSync(join(build, "version")), /ENOENT/)
    assert.equal(cleanStableBuilds(release, ""), false)
  } finally {
    rmSync(release, { recursive: true, force: true })
  }
})

test("cleaning refuses a Stable build that is still running", () => {
  const release = mkdtempSync(join(tmpdir(), "pi-lab-stable-running-"))
  try {
    const build = join(release, "stable", "builds", "one", "mac-arm64", "PI Lab.app")
    mkdirSync(build, { recursive: true })
    writeFileSync(join(build, "version"), "test")
    const running = `42 ${build}/Contents/MacOS/PI Lab --test\n`

    assert.throws(() => cleanStableBuilds(release, running), /still running/)
    assert.equal(readFileSync(join(build, "version"), "utf8"), "test")
  } finally {
    rmSync(release, { recursive: true, force: true })
  }
})

test("cleaning leaves unexpected files in Stable output untouched", () => {
  const release = mkdtempSync(join(tmpdir(), "pi-lab-stable-unknown-"))
  try {
    const stable = join(release, "stable")
    mkdirSync(stable)
    writeFileSync(join(stable, "notes.txt"), "keep")

    assert.throws(() => cleanStableBuilds(release, ""), /unexpected Stable output/)
    assert.equal(readFileSync(join(stable, "notes.txt"), "utf8"), "keep")
  } finally {
    rmSync(release, { recursive: true, force: true })
  }
})

test("a second package cannot replace Stable while tests run before cleanup", async () => {
  const release = mkdtempSync(join(tmpdir(), "pi-lab-stable-overlap-"))
  try {
    await runStablePackageWorkflow(
      release,
      async () => {
        const build = join(release, "stable", "builds", "one", "mac-arm64", "PI Lab.app")
        mkdirSync(build, { recursive: true })
      },
      () => {
        assert.throws(() => acquireBuildLock(release, "another-build"), /already being packaged/)
      },
      () => "",
    )
    const unlock = acquireBuildLock(release, "next-build")
    unlock()
    assert.equal(cleanStableBuilds(release, ""), false)
  } finally {
    rmSync(release, { recursive: true, force: true })
  }
})
