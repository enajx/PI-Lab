import { execFile } from "node:child_process"
import { existsSync } from "node:fs"

const TRASH = "/usr/bin/trash"

/**
 * Move a file or folder to the macOS Trash: `/usr/bin/trash` where macOS has
 * it, otherwise the Finder through AppleScript (older macOS versions).
 */
export function trashPath(path: string): Promise<void> {
  if (process.platform !== "darwin") {
    return Promise.reject(
      new Error(`Moving to the Trash is only supported on macOS (platform: ${process.platform}).`),
    )
  }
  const [command, args] = existsSync(TRASH)
    ? [TRASH, [path]]
    : [
        "/usr/bin/osascript",
        [
          "-e",
          "on run argv",
          "-e",
          'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)',
          "-e",
          "end run",
          path,
        ],
      ]
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`Could not move ${path} to the Trash: ${stderr.trim() || error.message}`))
        return
      }
      resolve()
    })
  })
}
