// @ts-check
const { join } = require("node:path")
const { assertPackageOutputIdle } = require("./assert-package-output-idle.cjs")

/** Recheck the resolved output immediately before electron-builder replaces it. */
exports.default = async function beforePack(context) {
  if (context.electronPlatformName !== "darwin") return
  assertPackageOutputIdle(
    join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
  )
}
