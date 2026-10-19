import type { Workspace } from "@pi-lab/local-db"
import { GitBranch, GitFork } from "lucide-react"
import { useTranslate } from "../../../../../i18n/language"

/**
 * Small badge surfacing the worktree policy outcome: branch (the project's main checkout) vs. an isolated worktree.
 * Extracted from the old project route so the project view and the central
 * panel's agent tabs can both show it.
 */
export function KindBadge({ kind }: { kind: Workspace["kind"] }) {
  const t = useTranslate()
  const isWorktree = kind === "worktree"
  return (
    <span
      data-testid="kind-badge"
      data-kind={kind}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-secondary-foreground text-xs"
    >
      {isWorktree ? (
        <GitFork className="size-3" aria-hidden />
      ) : (
        <GitBranch className="size-3" aria-hidden />
      )}
      {isWorktree ? t("worktree") : t("main")}
    </span>
  )
}
