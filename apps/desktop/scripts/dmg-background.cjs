#!/usr/bin/env node
// @ts-check
const { createRequire } = require("node:module")
const { join } = require("node:path")
const { spawnSync } = require("node:child_process")
const builderRequire = createRequire(require.resolve("electron-builder"))
const { downloadBuilderToolset } = builderRequire("app-builder-lib/out/util/electronGet")

/** Use the same cached, checksum-verified Python toolset as dmg-builder 26.15.3. */
async function main() {
  const arch = process.arch === "arm64" ? "arm64" : "x86_64"
  const root = await downloadBuilderToolset({
    releaseName: "dmg-builder@1.2.5",
    filenameWithExt: `dmgbuild-bundle-${arch}-75c8a6c.tar.gz`,
    checksums: {
      "dmgbuild-bundle-arm64-75c8a6c.tar.gz":
        "793404d0c96687e27d5ee40a668d498c92e36a64d6c2906df511031adb33cbeb",
      "dmgbuild-bundle-x86_64-75c8a6c.tar.gz":
        "1664972f9cc2d6e8fce3b63e42cd30078aff602669c5856939c4519921200433",
    },
  })
  const result = spawnSync(
    join(root, "python/bin/python3"),
    [join(__dirname, "dmg_background.py"), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, PYTHONPATH: join(root, "python/lib") } },
  )
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Installer background build failed (${result.status})`)
}

void main()
