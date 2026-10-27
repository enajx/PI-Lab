const assert = require("node:assert/strict")
const { test } = require("node:test")
const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } = require("node:fs")
const { tmpdir } = require("node:os")
const { join } = require("node:path")
const { createHash } = require("node:crypto")
const { execFileSync } = require("node:child_process")
const { selectAsset, prepareLatexRuntime } = require("./prepare-latex-runtime.cjs")

test("selects pinned native assets and rejects unsupported Windows ARM", () => {
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["linux", "x64"],
    ["win32", "x64"],
  ]) {
    assert.match(selectAsset(platform, arch).sha256, /^[a-f0-9]{64}$/)
  }
  assert.throws(() => selectAsset("win32", "arm64"), /Unsupported bundled Tectonic target/)
})

test("stages a verified archive, reuses its cache and rejects a changed archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-latex-stage-"))
  try {
    const source = join(root, "source")
    mkdirSync(source)
    writeFileSync(join(source, "tectonic"), "#!/bin/sh\necho fixture\n")
    const archive = join(root, "fixture.tar.gz")
    execFileSync("tar", ["-czf", archive, "-C", source, "tectonic"])
    const data = readFileSync(archive)
    const asset = {
      filename: "fixture.tar.gz",
      sha256: createHash("sha256").update(data).digest("hex"),
    }
    let downloads = 0
    const options = {
      platform: "darwin",
      arch: "arm64",
      resourcesDir: join(root, "resources"),
      cacheDir: join(root, "cache"),
      asset,
      download: async () => {
        downloads++
        return data
      },
    }
    const path = await prepareLatexRuntime(options)
    assert.equal(readFileSync(path, "utf8"), "#!/bin/sh\necho fixture\n")
    await prepareLatexRuntime(options)
    assert.equal(downloads, 1)
    writeFileSync(join(options.cacheDir, asset.filename), "changed")
    await assert.rejects(prepareLatexRuntime(options), /SHA-256 mismatch/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("rejects an oversized download before reading its body (mocked HTTP)", async (context) => {
  const { downloadArchive } = require("./prepare-latex-runtime.cjs")
  context.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(null, {
        status: 200,
        headers: { "Content-Length": String(65 * 1024 * 1024) },
      }),
  )
  await assert.rejects(downloadArchive("https://example.invalid/archive"), /exceeds download limit/)
})

test("packages exact native resource paths outside ASAR", () => {
  const config = require("../electron-builder.config.cjs")
  for (const [key, platform] of [
    ["mac", "darwin"],
    ["linux", "linux"],
    ["win", "win32"],
  ]) {
    assert.ok(
      config[key].extraResources.some(
        (resource) =>
          resource.from === `resources/latex/${platform}-\${arch}` &&
          resource.to === `latex/${platform}-\${arch}`,
      ),
    )
  }
  assert.ok(
    config.extraResources.some(
      (resource) => resource.from === "resources/latex" && resource.filter.includes("LICENSE"),
    ),
  )
  assert.equal(typeof config.beforePack, "function")
})

test("extracts and launches the pinned official native binary", {
  skip: !process.env.PI_LAB_TECTONIC_TEST_ARCHIVE,
}, async () => {
  const { copyFileSync } = require("node:fs")
  const root = mkdtempSync(join(tmpdir(), "pi-latex-official-"))
  try {
    const cacheDir = join(root, "cache")
    mkdirSync(cacheDir)
    const asset = selectAsset(process.platform, process.arch)
    copyFileSync(process.env.PI_LAB_TECTONIC_TEST_ARCHIVE, join(cacheDir, asset.filename))
    const path = await prepareLatexRuntime({
      platform: process.platform,
      arch: process.arch,
      resourcesDir: join(root, "resources"),
      cacheDir,
    })
    assert.match(execFileSync(path, ["--version"], { encoding: "utf8" }), /Tectonic 0\.17\.0/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
