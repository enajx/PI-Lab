import { Badge } from "@skipper/ui"
import type { LibraryPaper } from "../../../../../../../../main/trpc/science/library"

interface LibraryItemProps {
  paper: LibraryPaper
  /** Stable test id for the card (`library-item` for Zotero, `scholar-result` for S2). */
  testId: string
}

/**
 * One paper card, shared by the Zotero library list and the Semantic Scholar
 * results so both render identically (AGENTS.md §9 — co-locate the shared piece).
 * Shows the title, authors, year, and item type; the abstract (when present) is
 * clamped to two lines. The title links out when the paper carries a URL.
 */
export function LibraryItem({ paper, testId }: LibraryItemProps) {
  const authors = paper.authors.join(", ")
  return (
    <article
      data-testid={testId}
      data-paper-id={paper.id}
      className="flex flex-col gap-1.5 rounded-lg border border-border bg-card/40 p-3"
    >
      <div className="flex items-start justify-between gap-2">
        {paper.url ? (
          <a
            href={paper.url}
            target="_blank"
            rel="noreferrer"
            data-testid="library-item-title"
            className="cursor-text select-text font-medium text-foreground text-sm leading-snug hover:underline"
          >
            {paper.title}
          </a>
        ) : (
          <span
            data-testid="library-item-title"
            className="cursor-text select-text font-medium text-foreground text-sm leading-snug"
          >
            {paper.title}
          </span>
        )}
        {paper.itemType ? (
          <Badge variant="muted" className="shrink-0 text-[10px]">
            {paper.itemType}
          </Badge>
        ) : null}
      </div>

      {authors || paper.year ? (
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          {authors ? (
            <span data-testid="library-item-authors" className="truncate" title={authors}>
              {authors}
            </span>
          ) : null}
          {paper.year ? <span data-testid="library-item-year">· {paper.year}</span> : null}
        </div>
      ) : null}

      {paper.abstract ? (
        <p className="line-clamp-2 text-muted-foreground/80 text-xs leading-relaxed">
          {paper.abstract}
        </p>
      ) : null}
    </article>
  )
}
