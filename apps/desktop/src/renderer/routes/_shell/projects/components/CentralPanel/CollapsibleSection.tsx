import { cn } from "@pi-lab/ui"
import { ChevronDown, ChevronRight } from "lucide-react"
import type { ReactNode } from "react"

interface CollapsibleSectionProps {
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Test id of the header button. */
  testId: string
  /** Classes for the section element (its size inside the column). */
  className: string
  children: ReactNode
}

/**
 * A section of the left column with a chevron header that shows or hides its
 * content. The caller owns (and keeps) the open state.
 */
export function CollapsibleSection({
  title,
  open,
  onOpenChange,
  testId,
  className,
  children,
}: CollapsibleSectionProps) {
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <section className={cn("flex min-h-0 flex-col", className)}>
      <button
        type="button"
        data-testid={testId}
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="flex shrink-0 items-center gap-1 px-2 py-1.5 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide hover:text-foreground"
      >
        <Chevron className="size-3.5" aria-hidden />
        {title}
      </button>
      {open ? children : null}
    </section>
  )
}
