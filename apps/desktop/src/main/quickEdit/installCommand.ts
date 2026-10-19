import { lstat, mkdir, readlink, rm, stat, symlink } from "node:fs/promises"
import { join, sep } from "node:path"

const COMMAND_TAIL = join("PI Lab.app", "Contents", "Resources", "bin", "pilab")

/** Use the Stable alias so an installed command follows later repo builds. */
function currentStableScript(scriptPath: string): string {
  const parts = scriptPath.split(sep)
  const releaseIndex = parts.lastIndexOf("release")
  const buildId = parts[releaseIndex + 3]
  const architecture = parts[releaseIndex + 4]
  if (
    releaseIndex < 0 ||
    parts[releaseIndex + 1] !== "stable" ||
    parts[releaseIndex + 2] !== "builds" ||
    !buildId ||
    !architecture ||
    parts.slice(releaseIndex + 5).join(sep) !== COMMAND_TAIL
  ) {
    return scriptPath
  }
  return join(parts.slice(0, releaseIndex + 2).join(sep), architecture, COMMAND_TAIL)
}

/** Install the packaged launcher under a user-owned bin directory. */
export async function installCommand(home: string, scriptPath: string): Promise<string> {
  const script = await stat(scriptPath)
  if (!script.isFile()) throw new Error("The bundled pilab command is missing")
  const currentScript = currentStableScript(scriptPath)
  const current = await stat(currentScript)
  if (!current.isFile()) throw new Error("The current Stable pilab command is missing")
  const bin = join(home, ".local", "bin")
  const link = join(bin, "pilab")
  await mkdir(bin, { recursive: true })
  const existing = await lstat(link).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null
    throw error
  })
  if (existing) {
    if (!existing.isSymbolicLink())
      throw new Error(`${link} already exists. PI Lab did not replace it.`)
    const previous = await readlink(link)
    if (previous === currentScript) return link
    if (!previous.endsWith(COMMAND_TAIL)) {
      throw new Error(`${link} already exists. PI Lab did not replace it.`)
    }
    await rm(link)
  }
  await symlink(currentScript, link)
  return link
}
