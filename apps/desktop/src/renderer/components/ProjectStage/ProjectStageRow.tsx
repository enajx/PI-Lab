import type { ProjectStage } from "@pi-lab/local-db"
import { cn } from "@pi-lab/ui"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Fragment } from "react"
import { useTranslate } from "../../i18n/language"
import { useTRPC } from "../../trpc/react"

/** The project stages, in order, with their display names. */
const STEPS: readonly { id: ProjectStage; label: string }[] = [
  { id: "planning", label: "Planning" },
  { id: "experiments", label: "Experiments" },
  { id: "paperWriting", label: "Paper writing" },
  { id: "submitted", label: "Submitted" },
]

/**
 * The stage a click on step `index` sets: that step, or, on
 * the current step, the step before it (no stage before the first one).
 */
function nextStage(index: number, currentIndex: number): ProjectStage | null {
  const target = index === currentIndex ? index - 1 : index
  if (target < 0) return null
  const step = STEPS[target]
  if (!step) throw new Error(`No project stage step ${target}`)
  return step.id
}

/**
 * A small row of circles joined by a thin line showing the project stage:
 * reached steps and the lines between them are filled, and the current step has
 * a ring. Clicking a step (or pressing Enter or Space on it) saves it as the stage;
 * clicking the current step moves back one step. The click does not reach the
 * host, so on the project card it does not open the project. Saves through
 * `projects.setStage` and refreshes the project list and project queries.
 */
export function ProjectStageRow({
  projectId,
  stage,
  testId,
  className,
}: {
  projectId: string
  stage: ProjectStage | null
  testId: string
  /** Placement classes from the host (padding, alignment). */
  className: string
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const setStage = useMutation(
    trpc.projects.setStage.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() })
        void queryClient.invalidateQueries({
          queryKey: trpc.projects.get.queryKey({ id: projectId }),
        })
      },
    }),
  )
  const currentIndex = stage === null ? -1 : STEPS.findIndex((step) => step.id === stage)
  const choose = (index: number) => {
    if (setStage.isPending) return
    setStage.mutate({ id: projectId, stage: nextStage(index, currentIndex) })
  }

  return (
    <div data-testid={testId} className={cn("flex select-none items-center gap-1.5", className)}>
      <div className="flex items-center">
        {STEPS.map((step, index) => {
          const filled = index <= currentIndex
          const current = index === currentIndex
          const label = t(step.label)
          return (
            <Fragment key={step.id}>
              {index > 0 ? (
                <span
                  data-testid={`${testId}-line`}
                  data-filled={filled}
                  aria-hidden
                  className={cn("h-px w-3", filled ? "bg-muted-foreground" : "bg-border")}
                />
              ) : null}
              <button
                type="button"
                data-testid={`${testId}-step-${step.id}`}
                data-filled={filled}
                aria-current={current ? "step" : undefined}
                aria-label={current ? `${label} ${t("(current stage)")}` : label}
                title={`${label}. ${t("Click to set")}`}
                onClick={(event) => {
                  event.stopPropagation()
                  // The second click of a double-click is not a second choice.
                  if (event.detail > 1) return
                  choose(index)
                }}
                onDoubleClick={(event) => event.stopPropagation()}
                className="group/step rounded-full p-1 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                <span
                  aria-hidden
                  className={cn(
                    "block size-2 rounded-full border transition-colors",
                    filled
                      ? "border-muted-foreground bg-muted-foreground"
                      : "border-muted-foreground/50 group-hover/step:border-muted-foreground",
                    current && "border-foreground bg-foreground ring-2 ring-foreground/20",
                  )}
                />
              </button>
            </Fragment>
          )
        })}
      </div>
      {setStage.isError ? (
        <span role="alert" className="truncate text-destructive text-xs">
          {t("Could not save the stage:")} {setStage.error.message}
        </span>
      ) : null}
    </div>
  )
}
