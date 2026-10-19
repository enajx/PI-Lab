import { readFileSync } from "node:fs"
import { join } from "node:path"

export type PublicUpdateChannel = "stable" | "beta"

export interface PublicRelease {
  channel: PublicUpdateChannel
}

/** Read public-release metadata without activating updates in local packages. */
export function publicReleaseFromPackage(
  isPackaged: boolean,
  appPath: string,
): PublicRelease | null {
  if (!isPackaged) return null
  const metadata: {
    piLabChannel?: unknown
    piLabPublicRelease?: unknown
    piLabReleaseChannel?: unknown
  } = JSON.parse(readFileSync(join(appPath, "package.json"), "utf8"))
  if (metadata.piLabPublicRelease !== true) return null
  if (metadata.piLabChannel !== "stable") {
    throw new Error("Public PI Lab releases must keep the stable app identity")
  }
  const channel = metadata.piLabReleaseChannel
  if (channel !== "stable" && channel !== "beta") {
    throw new Error(`Invalid public release channel: ${String(channel)}`)
  }
  return { channel }
}

/** Map the public names to electron-builder's update feed file names. */
export function updaterFeedChannel(channel: PublicUpdateChannel): "latest" | "beta" {
  if (channel === "stable") return "latest"
  return "beta"
}
