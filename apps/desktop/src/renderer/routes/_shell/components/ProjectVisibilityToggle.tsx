import { Button, cn } from "@pi-lab/ui"
import { Eye, EyeOff } from "lucide-react"

/**
 * Shared recoverability control for hidden projects. Dashboard and sidebar use
 * one synchronized temporary reveal state and expose the same wording, icon,
 * pressed state, and behavior so hiding a project is never a one-way action.
 */
export function ProjectVisibilityToggle({
  hiddenCount,
  showHidden,
  collapsed,
  testId,
  onToggle,
  className,
}: {
  hiddenCount: number
  showHidden: boolean
  collapsed: boolean
  testId: string
  onToggle: () => void
  className?: string
}) {
  if (hiddenCount === 0) return null

  const label = showHidden ? "Hide hidden projects" : `Show hidden projects (${hiddenCount})`
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid={testId}
      aria-label={label}
      aria-pressed={showHidden}
      title={collapsed ? label : undefined}
      data-feature-label={showHidden ? "Hide hidden" : `Show hidden (${hiddenCount})`}
      data-feature-help={
        showHidden
          ? "Return hidden projects to their normal hidden state"
          : "Temporarily reveal projects hidden from the Dashboard and sidebar"
      }
      className={cn(
        "h-8 gap-1.5 text-muted-foreground",
        collapsed && "w-full justify-center px-0",
        className,
      )}
      onClick={onToggle}
    >
      {showHidden ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
      {collapsed ? null : showHidden ? "Hide hidden" : `Show hidden (${hiddenCount})`}
    </Button>
  )
}
