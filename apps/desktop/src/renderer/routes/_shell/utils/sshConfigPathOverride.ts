/**
 * Test seam (AGENTS.md §14): let the Cluster E2E import from a fixture ssh-config
 * instead of the real `~/.ssh/config`. When the renderer loads with
 * `?sshConfigPath=<abs path>` (mirrors the existing `?openProject` / `?termcmd`
 * seams), the Cluster tab imports from that path on mount so the harness can seed
 * deterministic machines without touching the developer's actual ssh config.
 * Absent in normal use — there the user clicks "Import from SSH config" and the
 * default `~/.ssh/config` is read.
 */
export function readSshConfigPathOverride(): string | null {
  if (typeof window === "undefined") return null
  const path = new URLSearchParams(window.location.search).get("sshConfigPath")?.trim()
  return path && path.length > 0 ? path : null
}
