const assert = require("node:assert/strict")
const { test } = require("node:test")
const { cmakeFlags, prepareForPack, verifySource } = require("./prepare-whisper-runtime.cjs")

test("builds a static, Metal-embedded engine for each macOS architecture", () => {
  assert.ok(cmakeFlags("arm64").includes("-DCMAKE_OSX_ARCHITECTURES=arm64"))
  assert.ok(cmakeFlags("x64").includes("-DCMAKE_OSX_ARCHITECTURES=x86_64"))
  for (const flag of [
    "-DBUILD_SHARED_LIBS=OFF",
    "-DGGML_METAL=ON",
    "-DGGML_METAL_EMBED_LIBRARY=ON",
  ])
    assert.ok(cmakeFlags("arm64").includes(flag), flag)
  assert.throws(() => cmakeFlags("ia32"), /Unsupported whisper.cpp architecture/)
})

test("rejects a changed source tarball", () => {
  assert.throws(() => verifySource(Buffer.from("changed"), "0".repeat(64)), /SHA-256 mismatch/)
})

test("skips the engine for non-macOS packages", async () => {
  assert.equal(await prepareForPack({ electronPlatformName: "linux", arch: 1 }), null)
})
