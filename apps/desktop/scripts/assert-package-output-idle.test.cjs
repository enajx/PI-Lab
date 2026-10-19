const assert = require("node:assert/strict")
const { mkdtempSync, symlinkSync, mkdirSync, rmSync } = require("node:fs")
const { test } = require("node:test")
const { tmpdir } = require("node:os")
const { dirname, join } = require("node:path")
const { assertBundleIdle, runningBundlePids } = require("./assert-package-output-idle.cjs")

test("finds the running packaged app without mistaking helpers or other bundles for it", () => {
  const bundle = "/repo/release/mac-arm64/PI Lab.app"
  const processes = [
    `123 /repo/release/mac-arm64/PI Lab.app/Contents/MacOS/PI Lab`,
    `124 /repo/release/mac-arm64/PI Lab.app/Contents/Frameworks/PI Lab Helper.app/Contents/MacOS/PI Lab Helper --type=renderer`,
    `125 /repo/release/quick-editor-python/PI Lab.app/Contents/MacOS/PI Lab`,
    `126 /repo/release/mac-arm64/PI Lab.app.old/Contents/MacOS/PI Lab`,
    `127 /repo/release/mac-arm64/PI Lab.app/Contents/MacOS/PI Lab /repo/release/mac-arm64/PI Lab.app/Contents/Resources/app.asar/out/pty-daemon/index.js /tmp/daemon.sock`,
  ].join("\n")
  assert.deepEqual(runningBundlePids(processes, bundle), [123])
})

test("finds more than one app process, including one opened with a file argument", () => {
  const bundle = "/repo/release/mac-arm64/PI Lab.app"
  const processes = [
    `7 /repo/release/mac-arm64/PI Lab.app/Contents/MacOS/PI Lab /tmp/test.py`,
    `8 /repo/release/mac-arm64/PI Lab.app/Contents/MacOS/PI Lab`,
  ].join("\n")
  assert.deepEqual(runningBundlePids(processes, bundle), [7, 8])
})

test("refuses to overwrite a bundle if a process launches after the first check", () => {
  const bundle = "/tmp/isolated/mac-arm64/PI Lab.app"
  const processList = `77 ${bundle}/Contents/MacOS/PI Lab`
  assert.throws(() => assertBundleIdle(bundle, processList), /PID 77/)
  assert.doesNotThrow(() => assertBundleIdle(bundle, ""))
})

test("resolves a channel alias to the immutable bundle used by the running process", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-lab-package-guard-"))
  try {
    const bundle = join(root, "builds", "one", "PI Lab Alpha.app")
    const alias = join(root, "mac-arm64", "PI Lab Alpha.app")
    mkdirSync(bundle, { recursive: true })
    mkdirSync(join(root, "mac-arm64"), { recursive: true })
    symlinkSync(bundle, alias)
    const processList = `92 ${bundle}/Contents/MacOS/PI Lab Alpha /tmp/test.py`
    assert.throws(() => assertBundleIdle(alias, processList), /PID 92/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("detects an app launched through its Applications link", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-lab-applications-link-"))
  try {
    const build = join(root, "builds", "one", "PI Lab Alpha.app")
    const alias = join(root, "release", "PI Lab Alpha.app")
    const shortcut = join(root, "Applications", "PI Lab Alpha.app")
    mkdirSync(build, { recursive: true })
    mkdirSync(dirname(alias), { recursive: true })
    mkdirSync(dirname(shortcut), { recursive: true })
    symlinkSync(build, alias)
    symlinkSync(alias, shortcut)
    const commands = `42 ${shortcut}/Contents/MacOS/PI Lab Alpha\n43 ${build}/Contents/MacOS/PI Lab Alpha`
    assert.deepEqual(runningBundlePids(commands, shortcut), [42, 43])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
