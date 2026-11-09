import { cn } from "@pi-lab/ui"
import { Activity } from "lucide-react"
import { lazy, Suspense, useState } from "react"
import { useTranslate } from "../../i18n/language"

const ProjectStatusDialog = lazy(() =>
  import("./ProjectStatusDialog").then((module) => ({ default: module.ProjectStatusDialog })),
)

/**
 * The "Project status" button, used on the Dashboard project card (compact,
 * icon-only) and in the project-view header (labeled). Clicking it opens the
 * Project status card: the project's last activity and its stored project
 * summary, with a button to update that summary. Opening the card never runs an
 * agent; only the card's "Update project summary" button does.
 */
export function ProjectStatusControl({
  projectId,
  projectName,
  lastOpenedAt,
  variant,
  testId,
  gitAvailable,
  gitDisabledReason,
}: {
  projectId: string
  projectName: string
  /** When the project was last opened (epoch ms); 0 when unknown. */
  lastOpenedAt: number
  variant: "compact" | "labeled"
  /** Stable data-testid for the button (e.g. `project-card-status-button`). */
  testId: string
  /** Whether the project is Git-backed; the summary update needs Git. */
  gitAvailable: boolean
  /** Why the summary update is disabled when Git is unavailable. */
  gitDisabledReason: string
}) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const label = t("Project status")
  return (
    <>
      <button
        type="button"
        data-testid={testId}
        aria-label={`${label} ${t("for")} ${projectName}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        data-feature-label={label}
        data-feature-help={t(
          "See this project's last activity and its stored project summary, and update the summary",
        )}
        onClick={() => setOpen(true)}
        className={cn(
          "border-border text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:bg-accent/60",
          variant === "compact"
            ? "inline-flex h-7 flex-1 items-center justify-center rounded-md border"
            : "flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs",
        )}
      >
        <Activity
          className={cn("shrink-0", variant === "compact" ? "size-4" : "size-3.5")}
          aria-hidden
        />
        {variant === "labeled" ? <span>{label}</span> : null}
      </button>
      {open ? (
        // The dialog code loads in a moment; an inline placeholder would sit inside the
        // card's button row, so nothing is drawn until the centred dialog is ready.
        <Suspense fallback={null}>
          <ProjectStatusDialog
            projectId={projectId}
            projectName={projectName}
            lastOpenedAt={lastOpenedAt}
            gitAvailable={gitAvailable}
            gitDisabledReason={gitDisabledReason}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      ) : null}
    </>
  )
}
