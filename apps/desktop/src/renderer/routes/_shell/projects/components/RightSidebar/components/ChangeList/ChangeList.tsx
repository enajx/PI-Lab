import { useTranslate } from "../../../../../../../i18n/language"
import type { GitChange } from "../../../../../../../trpc/types"

interface ChangeListProps {
  changes: GitChange[]
  /** Whether the backing query is still loading (drives the empty-state copy). */
  isPending?: boolean
  /** Test id for the empty/loading row (so each host panel asserts its own). */
  emptyTestId: string
}

/**
 * Render a list of working-tree changes — one row per path with a status glyph,
 * the path (selectable, monospace), and stable `data-*` for assertions. Shared
 * by the Changes panel and the Status panel so the two never drift. Empty/loading
 * collapses to a single muted line.
 */
export function ChangeList({ changes, isPending, emptyTestId }: ChangeListProps) {
  const t = useTranslate()
  if (changes.length === 0) {
    return (
      <p data-testid={emptyTestId} className="text-muted-foreground text-xs">
        {t(isPending ? "Loading…" : "No changes")}
      </p>
    )
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {changes.map((change) => (
        <ChangeRow key={change.path} change={change} />
      ))}
    </ul>
  )
}

/** One changed path: a short status glyph + the path. */
function ChangeRow({ change }: { change: GitChange }) {
  return (
    <li
      data-testid="change-item"
      data-status={change.status}
      data-path={change.path}
      className="flex items-center gap-2 text-sm"
    >
      <span
        className="w-4 shrink-0 text-center font-mono text-muted-foreground text-xs"
        title={change.status}
      >
        {statusGlyph(change.status)}
      </span>
      <span className="min-w-0 flex-1 cursor-text select-text truncate font-mono text-xs">
        {change.path}
      </span>
    </li>
  )
}

/** Single-letter glyph for a change status (familiar git-style shorthand). */
function statusGlyph(status: GitChange["status"]): string {
  switch (status) {
    case "added":
      return "A"
    case "deleted":
      return "D"
    case "renamed":
      return "R"
    case "copied":
      return "C"
    case "untracked":
      return "?"
    case "conflicted":
      return "U"
    case "typechange":
      return "T"
    default:
      return "M"
  }
}
