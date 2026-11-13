import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Short git commit of this build. A packaged Alpha reads the `piLabCommit` that
 * electron-builder wrote into its package.json; other packaged builds (Beta,
 * Stable) have none and return null. A source run asks git in `appPath`, and
 * shows "dev" when that is not a git checkout.
 */
export function readBuildCommit(isPackaged: boolean, appPath: string): string | null {
  if (isPackaged) {
    const metadata: { piLabCommit?: unknown } = JSON.parse(
      readFileSync(join(appPath, "package.json"), "utf8"),
    )
    if (metadata.piLabCommit === undefined) return null
    if (typeof metadata.piLabCommit !== "string" || !metadata.piLabCommit.trim())
      throw new Error("Invalid build commit in packaged metadata")
    return metadata.piLabCommit
  }
  const git = spawnSync("git", ["rev-parse", "--short=8", "HEAD"], {
    cwd: appPath,
    encoding: "utf8",
  })
  if (git.error) throw git.error
  return git.status === 0 ? git.stdout.trim() : "dev"
}
