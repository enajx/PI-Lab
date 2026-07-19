import { join } from "node:path"
import { resolveDataDir } from "@pi-lab/local-db"
import { slugify } from "@pi-lab/shared"

/**
 * Compute the on-disk location for a managed worktree. PI Lab owns these
 * checkouts under its data dir (honoring `PI_LAB_DATA_DIR`), namespaced by
 * project id so two projects' worktrees never collide, and by a slug of the
 * branch so the path is human-recognizable:
 *
 *   $PI_LAB_DATA_DIR/worktrees/<projectId>/<branch-slug>
 *
 * Keeping managed worktrees out of the user's repo directory means deleting a
 * workspace never disturbs files the user can see.
 */
export function managedWorktreePath(projectId: string, branch: string, dataDir?: string): string {
  const root = dataDir ?? resolveDataDir()
  const slug = slugify(branch, { fallback: "workspace" })
  return join(root, "worktrees", projectId, slug)
}
