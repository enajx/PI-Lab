// @ts-check

/** Keep public update tracks separate from local Alpha/Beta app identities. */
function publicReleaseDefinition(channel, version) {
  const tracks = {
    stable: { updaterChannel: "latest", iconChannel: "stable", suffix: "" },
    beta: { updaterChannel: "beta", iconChannel: "beta", suffix: "beta" },
  }
  const track = tracks[channel]
  if (!track) throw new Error(`Unknown public release channel: ${channel}`)
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.([0-9A-Za-z.-]+))?$/.exec(version || "")
  if (!match || match.slice(1, 4).every((part) => Number(part) === 0)) {
    throw new Error("Public releases require a positive version such as 1.0.0")
  }
  if (track.suffix === "" && match[4]) throw new Error("Stable version cannot be a prerelease")
  if (track.suffix !== "" && match[4] !== track.suffix) {
    throw new Error(`${channel} version must use -${track.suffix}.N`)
  }
  return {
    channel,
    updaterChannel: track.updaterChannel,
    iconChannel: track.iconChannel,
    version,
    productName: "PI Lab",
    appId: "com.pi-lab.desktop",
  }
}

/** Public builds use HTTPS; isolated updater tests may use a local feed. */
function publicUpdateUrl(value, testBuild) {
  if (!value) throw new Error("PI_LAB_UPDATE_URL is required for a public release build")
  const url = new URL(value)
  if (testBuild) {
    const localServer =
      ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    if (localServer || url.protocol === "file:") return url.toString()
    if (url.protocol === "https:") throw new Error("Test builds require a local feed")
  }
  if (url.protocol === "https:" && !testBuild) return url.toString()
  throw new Error("Public update URL must use HTTPS")
}

/** Prevent an unsigned or unnotarized package from being labelled as public. */
function assertPublicReleaseCredentials(env, testBuild) {
  if (testBuild) return
  const appleIdCredentials = env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID
  const keychainCredentials = env.APPLE_KEYCHAIN && env.APPLE_KEYCHAIN_PROFILE
  if (!appleIdCredentials && !keychainCredentials) {
    throw new Error("Public release builds require Apple notarization credentials")
  }
}

module.exports = { assertPublicReleaseCredentials, publicReleaseDefinition, publicUpdateUrl }
