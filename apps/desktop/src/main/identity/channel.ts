import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Beta remains readable for already built local Beta apps and for public Beta icon artwork.
// New public Beta packages use the Stable app identity and data directory.
export type PiLabChannel = "alpha" | "beta" | "stable"

interface ChannelIdentity {
  name: string
  dataDirName: string
  autostartName: string
}

const IDENTITIES: Record<PiLabChannel, ChannelIdentity> = {
  alpha: {
    name: "PI Lab Alpha",
    dataDirName: ".pi-lab-alpha",
    autostartName: "com.pi-lab.desktop.alpha",
  },
  beta: {
    name: "PI Lab Beta",
    dataDirName: ".pi-lab-beta",
    autostartName: "com.pi-lab.desktop.beta",
  },
  stable: {
    name: "PI Lab",
    dataDirName: ".pi-lab",
    autostartName: "com.pi-lab.desktop",
  },
}

/** Read the packaged channel; old packages remain Stable, while source runs use Alpha. */
export function resolveAppChannel(isPackaged: boolean, appPath: string): PiLabChannel {
  if (!isPackaged) return "alpha"
  const metadata: { piLabChannel?: unknown } = JSON.parse(
    readFileSync(join(appPath, "package.json"), "utf8"),
  )
  const value = metadata.piLabChannel
  if (value === undefined) return "stable"
  if (value === "alpha" || value === "beta" || value === "stable") return value
  throw new Error(`Invalid PI Lab channel in packaged metadata: ${String(value)}`)
}

/** Identity values shared by the app name, state directory, and login item. */
export function channelIdentity(channel: PiLabChannel): ChannelIdentity {
  return IDENTITIES[channel]
}

/** Match a running app name to its packaged channel. */
export function channelFromAppName(name: string): PiLabChannel {
  if (name === IDENTITIES.alpha.name) return "alpha"
  if (name === IDENTITIES.beta.name) return "beta"
  return "stable"
}

/** Preserve explicit test data roots; otherwise keep each channel's state apart. */
export function channelDataDir(
  channel: PiLabChannel,
  override: string | undefined,
): string | undefined {
  if (override?.trim()) return override.trim()
  return channel === "stable" ? undefined : join(homedir(), IDENTITIES[channel].dataDirName)
}
