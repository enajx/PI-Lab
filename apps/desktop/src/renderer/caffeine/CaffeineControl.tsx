import { cn } from "@pi-lab/ui"
import { Coffee } from "lucide-react"
import { type CaffeineMode, useCaffeine } from "./useCaffeine"

const MODE_LABELS: Record<CaffeineMode, string> = {
  off: "Off",
  on: "On",
  auto: "Auto",
}

export function nextCaffeineMode(mode: CaffeineMode): CaffeineMode {
  if (mode === "off") return "on"
  if (mode === "on") return "auto"
  return "off"
}

/** Shared title-bar control rendered by every app route header. */
export function CaffeineControl({ className }: { className?: string }) {
  const { status, setMode, isChanging } = useCaffeine()
  const nextMode = nextCaffeineMode(status.mode)
  const modeLabel = MODE_LABELS[status.mode]
  const nextLabel = MODE_LABELS[nextMode]
  const title = "Prevent the computer from sleeping."
  const ariaLabel = `Caffeine ${modeLabel}: prevent the computer from sleeping. Click to switch to ${nextLabel}.`

  return (
    <button
      type="button"
      data-testid="caffeine-control"
      data-mode={status.mode}
      data-held={status.held}
      aria-label={ariaLabel}
      title={title}
      disabled={isChanging}
      onClick={() => setMode(nextMode)}
      className={cn(
        "caffeine-control app-no-drag inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors disabled:opacity-60",
        status.mode === "off" && "border-border text-muted-foreground hover:text-foreground",
        status.mode === "on" && "border-border bg-muted/50 text-foreground hover:bg-muted",
        status.mode === "auto" && "border-border bg-muted/50 text-foreground hover:bg-muted",
        className,
      )}
      data-feature-label="Caffeine"
      data-feature-help="Prevent the computer from sleeping."
    >
      <Coffee className="size-4" />
      <span>{modeLabel}</span>
    </button>
  )
}
