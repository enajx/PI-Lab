const assert = require("node:assert/strict")
const {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require("node:fs")
const { test } = require("node:test")
const { tmpdir } = require("node:os")
const { join } = require("node:path")
const { linkChannelApp, linkCurrentChannelApps } = require("./install-applications.cjs")

function app(root, name, version) {
  const bundle = join(root, `${name}.app`)
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(bundle, "version"), version)
  return bundle
}

test("Applications Alpha link follows the channel alias across builds", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-lab-app-links-"))
  try {
    const applications = join(root, "Applications")
    const aliasRoot = join(root, "release")
    mkdirSync(applications)
    for (const name of ["PI Lab Alpha"]) {
      const old = app(join(root, "builds", "one"), name, "one")
      const next = app(join(root, "builds", "two"), name, "two")
      mkdirSync(aliasRoot, { recursive: true })
      const alias = join(aliasRoot, `${name}.app`)
      symlinkSync(old, alias)
      const shortcut = linkChannelApp(alias, applications, name)
      assert.equal(readlinkSync(shortcut), alias)
      assert.equal(readFileSync(join(shortcut, "version"), "utf8"), "one")
      rmSync(alias)
      symlinkSync(next, alias)
      assert.equal(readFileSync(join(shortcut, "version"), "utf8"), "two")
      assert.equal(linkChannelApp(alias, applications, name), shortcut)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("link current channel apps adds only Alpha", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-lab-app-links-"))
  try {
    const applications = join(root, "Applications")
    const release = join(root, "release")
    mkdirSync(applications)
    app(join(release, "alpha", "mac-arm64"), "PI Lab Alpha", "one")
    assert.deepEqual(linkCurrentChannelApps(applications, release), [
      join(applications, "PI Lab Alpha.app"),
    ])
    assert.equal(
      readlinkSync(join(applications, "PI Lab Alpha.app")),
      join(release, "alpha", "mac-arm64", "PI Lab Alpha.app"),
    )
    assert.equal(readFileSync(join(applications, "PI Lab Alpha.app", "version"), "utf8"), "one")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Applications links refuse to overwrite a different app or link", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-lab-app-link-conflict-"))
  try {
    const applications = join(root, "Applications")
    mkdirSync(applications)
    const alias = app(root, "PI Lab Alpha source", "one")
    const installed = app(applications, "PI Lab Alpha", "old")
    assert.throws(() => linkChannelApp(alias, applications, "PI Lab Alpha"), /Refusing/)
    assert.equal(readFileSync(join(installed, "version"), "utf8"), "old")
    rmSync(installed, { recursive: true })
    symlinkSync("/tmp/some-other-app", installed)
    assert.throws(() => linkChannelApp(alias, applications, "PI Lab Alpha"), /Refusing/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
