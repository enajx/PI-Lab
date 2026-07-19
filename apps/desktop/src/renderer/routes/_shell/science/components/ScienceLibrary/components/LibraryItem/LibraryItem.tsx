import { Badge } from "@pi-lab/ui"
import type { ReactNode } from "react"
import type { LibraryPaper } from "../../../../../../../../main/trpc/science/library"

interface LibraryItemProps {
  paper: LibraryPaper
  /** Stable test id for the card (`library-item`). */
  testId: string
  /** Optional per-item action slot (Zotero passes "Attach file…"; a folder passes "Open"). */
  action?: ReactNode
  /** Highlighted as the keyboard-navigation cursor (also marked `data-selected`). */
  selected?: boolean
}

/**
 * One paper card in the library browser. Shows the title, authors, year, and item type;
 * the abstract (when present) is clamped to two lines. The title links out when the paper
 * carries a URL. An optional `action` slot carries the per-source affordance (Zotero
 * "Attach", folder "Open").
 */
export function LibraryItem({ paper, testId, action, selected }: LibraryItemProps) {
  const authors = paper.authors.join(", ")
  return (
    <article
      data-testid={testId}
      data-paper-id={paper.id}
      data-selected={selected || undefined}
      className={`flex flex-col gap-1.5 rounded-lg border p-3 ${
        selected ? "border-primary bg-accent/60 ring-1 ring-primary" : "border-border bg-card/40"
      }`}
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
        <div className="flex shrink-0 items-center gap-2">
          {paper.itemType ? (
            <Badge variant="muted" className="text-[10px]">
              {paper.itemType}
            </Badge>
          ) : null}
          {action}
        </div>
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
