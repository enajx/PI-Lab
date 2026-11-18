import { execFile } from "node:child_process"
import { existsSync } from "node:fs"

const TRASH = "/usr/bin/trash"

/** Move a file or folder to the macOS Trash with `/usr/bin/trash` (macOS 14+). */
export function trashPath(path: string): Promise<void> {
  if (process.platform !== "darwin") {
    return Promise.reject(
      new Error(`Moving to the Trash is only supported on macOS (platform: ${process.platform}).`),
    )
  }
  if (!existsSync(TRASH)) {
    return Promise.reject(
      new Error(`${TRASH} was not found. Moving to the Trash needs macOS 14 or newer.`),
    )
  }
  return new Promise((resolve, reject) => {
    execFile(TRASH, [path], (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`Could not move ${path} to the Trash: ${stderr.trim() || error.message}`))
        return
      }
      resolve()
    })
  })
}
