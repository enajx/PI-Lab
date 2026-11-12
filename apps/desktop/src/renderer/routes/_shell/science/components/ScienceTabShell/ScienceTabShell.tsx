import { cn } from "@pi-lab/ui"
import type { ReactNode } from "react"
import { LatexText } from "../../../../../components/LatexText"
import { useSidebarCollapsed } from "../../../../../preferences/preferences"
import {
  TitleBarSystemControls,
  titleBarControlClass,
  titleBarHeaderClass,
  titleBarInsetHeaderClass,
} from "../../../titleBar"

interface ScienceTabShellProps {
  /** Tab title, rendered in the fixed header. */
  title: string
  /** Optional one-line subtitle under the title. */
  subtitle?: ReactNode
  /** Right-aligned header actions (buttons, toggles). */
  actions?: ReactNode
  /** Stable test id on the shell root (e.g. `science-cluster`). */
  testId?: string
  /**
   * `flush`: a full-width header line over a body that fills the view edge to edge.
   * `cards`: like the project view, no header line and a 12px margin and gap, so
   * the body's panels sit as separate rounded cards on the window background.
   */
  layout: "flush" | "cards"
  children: ReactNode
}

/**
 * Shared chrome for every science tab: a
 * fixed header (title + optional subtitle + actions) over a bounded, scroll-
 * managed body. The body is the one place each tab owns its own vertical scroll
 * via a native `min-h-0 flex-1 overflow-y-auto` child — never a nested Radix
 * ScrollArea. This is the single seam where science-tab layout evolves, so all
 * tabs (Cluster now; Analysis / Skills / Library later) stay visually consistent.
 * `layout` picks the frame (see {@link ScienceTabShellProps.layout}).
 */
export function ScienceTabShell({
  title,
  subtitle,
  actions,
  testId,
  layout,
  children,
}: ScienceTabShellProps) {
  const [collapsed] = useSidebarCollapsed()
  const cards = layout === "cards"
  return (
    <div
      data-testid={testId}
      className={cn("flex h-full w-full flex-col overflow-hidden", cards && "gap-3 p-3")}
    >
      <header
        className={cn(
          "flex shrink-0 items-center justify-between gap-4",
          cards
            ? titleBarInsetHeaderClass(collapsed)
            : cn("border-border border-b py-3", titleBarHeaderClass(collapsed)),
        )}
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="truncate text-foreground text-sm tracking-tight">
            <LatexText text={title} />
          </h1>
          {subtitle ? <p className="truncate text-muted-foreground text-xs">{subtitle}</p> : null}
        </div>
        <div className={cn("flex shrink-0 items-center gap-2", titleBarControlClass(collapsed))}>
          {actions}
          <TitleBarSystemControls />
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  )
}
