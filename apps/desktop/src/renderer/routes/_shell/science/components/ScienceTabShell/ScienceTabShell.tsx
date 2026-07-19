import { cn } from "@pi-lab/ui"
import type { ReactNode } from "react"
import { CaffeineControl } from "../../../../../caffeine"
import { useSidebarCollapsed } from "../../../../../preferences/preferences"
import { titleBarControlClass, titleBarHeaderClass } from "../../../titleBar"

interface ScienceTabShellProps {
  /** Tab title, rendered in the fixed header. */
  title: string
  /** Optional one-line subtitle under the title. */
  subtitle?: ReactNode
  /** Right-aligned header actions (buttons, toggles). */
  actions?: ReactNode
  /** Stable test id on the shell root (e.g. `science-cluster`). */
  testId?: string
  children: ReactNode
}

/**
 * Shared chrome for every science tab (AGENTS.md "Scope" "Science tabs", AGENTS.md Pitfalls #3): a
 * fixed header (title + optional subtitle + actions) over a bounded, scroll-
 * managed body. The body is the one place each tab owns its own vertical scroll
 * via a native `min-h-0 flex-1 overflow-y-auto` child — never a nested Radix
 * ScrollArea. This is the single seam where science-tab layout evolves, so all
 * tabs (Cluster now; Analysis / Skills / Library later) stay visually consistent.
 */
export function ScienceTabShell({
  title,
  subtitle,
  actions,
  testId,
  children,
}: ScienceTabShellProps) {
  const [collapsed] = useSidebarCollapsed()
  return (
    <div data-testid={testId} className="flex h-full w-full flex-col overflow-hidden">
      <header
        className={cn(
          "flex shrink-0 items-center justify-between gap-4 border-border border-b py-3",
          titleBarHeaderClass(collapsed),
        )}
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="truncate font-semibold text-foreground text-sm tracking-tight">{title}</h1>
          {subtitle ? <p className="truncate text-muted-foreground text-xs">{subtitle}</p> : null}
        </div>
        <div className={cn("flex shrink-0 items-center gap-2", titleBarControlClass(collapsed))}>
          {actions}
          <CaffeineControl />
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  )
}
