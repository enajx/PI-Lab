import { access } from "node:fs/promises"
import { join } from "node:path"

export type LocalZoteroState = "running" | "installed" | "not-found"
export type SetupFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export type SetupPathExists = (path: string) => Promise<boolean>

/**
 * Prefer the local Zotero API (running), then conventional application paths
 * (installed but closed). Detection is local-only and never reads the library.
 */
export async function detectLocalZotero(
  httpFetch: SetupFetch,
  platform: NodeJS.Platform,
  home: string,
  pathExists: SetupPathExists,
): Promise<LocalZoteroState> {
  const running = await httpFetch("http://localhost:23119/api/users/0/items?limit=1", {
    signal: AbortSignal.timeout(1_500),
  }).then(
    (response) => response.ok,
    () => false,
  )
  if (running) return "running"

  const candidates =
    platform === "darwin"
      ? ["/Applications/Zotero.app", join(home, "Applications", "Zotero.app")]
      : platform === "win32"
        ? [
            join(process.env.ProgramFiles ?? "C:\\Program Files", "Zotero", "zotero.exe"),
            join(
              process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
              "Programs",
              "Zotero",
              "zotero.exe",
            ),
          ]
        : ["/usr/bin/zotero", "/usr/local/bin/zotero", join(home, ".local", "bin", "zotero")]
  const found = await Promise.all(candidates.map(pathExists))
  return found.some(Boolean) ? "installed" : "not-found"
}

export const liveSetupPathExists: SetupPathExists = (path) =>
  access(path).then(
    () => true,
    () => false,
  )
