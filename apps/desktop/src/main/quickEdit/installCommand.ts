import { lstat, mkdir, readlink, stat, symlink } from "node:fs/promises"
import { join } from "node:path"

/** Install the packaged launcher under a user-owned bin directory. */
export async function installCommand(home: string, scriptPath: string): Promise<string> {
  const script = await stat(scriptPath)
  if (!script.isFile()) throw new Error("The bundled pilab command is missing")
  const bin = join(home, ".local", "bin")
  const link = join(bin, "pilab")
  await mkdir(bin, { recursive: true })
  const existing = await lstat(link).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null
    throw error
  })
  if (existing) {
    if (existing.isSymbolicLink() && (await readlink(link)) === scriptPath) return link
    throw new Error(`${link} already exists. PI Lab did not replace it.`)
  }
  await symlink(scriptPath, link)
  return link
}
