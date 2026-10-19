// @ts-check
const { existsSync, lstatSync, readlinkSync, symlinkSync } = require("node:fs")
const { join } = require("node:path")

const APPLICATIONS_DIR = "/Applications"
const DESKTOP_DIR = join(__dirname, "..")

/** Create a Finder shortcut that follows the channel's current build. */
function linkChannelApp(alias, applicationsDir, productName) {
  if (!existsSync(alias)) throw new Error(`Channel app is missing: ${alias}`)
  const destination = join(applicationsDir, `${productName}.app`)
  const current = lstatSync(destination, { throwIfNoEntry: false })
  if (current) {
    if (current.isSymbolicLink() && readlinkSync(destination) === alias) return destination
    throw new Error(`Refusing to replace an existing Applications item: ${destination}`)
  }
  symlinkSync(alias, destination)
  return destination
}

/** Add the Alpha development app to Applications without copying its bundle. */
function linkCurrentChannelApps(applicationsDir, releaseDir) {
  const productName = "PI Lab Alpha"
  const alias = join(releaseDir, "alpha", "mac-arm64", `${productName}.app`)
  return [linkChannelApp(alias, applicationsDir, productName)]
}

if (require.main === module) {
  for (const destination of linkCurrentChannelApps(
    APPLICATIONS_DIR,
    join(DESKTOP_DIR, "release"),
  )) {
    process.stdout.write(`Linked ${destination}\n`)
  }
}

module.exports = { APPLICATIONS_DIR, linkChannelApp, linkCurrentChannelApps }
