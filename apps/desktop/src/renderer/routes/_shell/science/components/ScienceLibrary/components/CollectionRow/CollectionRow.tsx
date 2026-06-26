import { ChevronRight, Folder } from "lucide-react"

interface CollectionRowProps {
  name: string
  /** Top-level item count, shown when known. */
  itemCount?: number
  /** Drill into this collection (or the "All items" view). */
  onClick: () => void
  /** Highlighted as the keyboard-navigation cursor (also marked `data-selected`). */
  selected?: boolean
  testId?: string
}

/**
 * One clickable collection row in the library browser — a folder name, its item
 * count, and a chevron. Also used for the synthetic "All items" entry at the root.
 */
export function CollectionRow({ name, itemCount, onClick, selected, testId }: CollectionRowProps) {
  return (
    <button
      type="button"
      data-testid={testId ?? "library-collection"}
      data-selected={selected || undefined}
      onClick={onClick}
      className={`flex items-center gap-2 rounded-lg border p-3 text-left transition-colors hover:bg-accent/40 ${
        selected ? "border-primary bg-accent/60 ring-1 ring-primary" : "border-border bg-card/40"
      }`}
    >
      <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">{name}</span>
      {typeof itemCount === "number" ? (
        <span className="shrink-0 text-muted-foreground text-xs">{itemCount}</span>
      ) : null}
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  )
}
