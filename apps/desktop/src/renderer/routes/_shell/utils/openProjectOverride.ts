/**
 * Test seam: let the E2E open a project without driving the
 * native folder picker. When the renderer loads with `?openProject=<abs path>`
 * (mirrors the existing `?termcmd` seam), the sidebar reads it once on mount and
 * calls `projects.open` for that path, so the harness can add a known repo
 * deterministically. Absent in normal use — there the user clicks "Add project"
 * and the native dialog supplies the path.
 */
export function readOpenProjectOverride(): string | null {
  if (typeof window === "undefined") return null
  const params = new URLSearchParams(window.location.search)
  const path = params.get("openProject")?.trim()
  return path && path.length > 0 ? path : null
}
