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
 * host. Saves through `projects.setStage` and refreshes the project list and
 * project queries. The row is named "Project status": its hover text says so, and
 * the "What's this?" card shows that name with the current stage and how to set
 * it (each step carries the same text, as the card reads the hovered button).
 * Each step's accessible name is its own, e.g. "Planning step".
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
  const current = STEPS[currentIndex]
  const name = t("Project status")
  const help = current
    ? `${t("Current:")} ${t(current.label)}. ${t("Click a step to set it.")}`
    : t("Not started. Click a step to set it.")
  const choose = (index: number) => {
    if (setStage.isPending) return
    setStage.mutate({ id: projectId, stage: nextStage(index, currentIndex) })
  }

  return (
    <div
      data-testid={testId}
      title={name}
      data-feature-label={name}
      data-feature-help={help}
      className={cn("flex select-none items-center gap-1.5", className)}
    >
      <div className="flex items-center">
        {STEPS.map((step, index) => {
          const filled = index <= currentIndex
          const isCurrent = index === currentIndex
          const label = `${t(step.label)} ${t("step")}`
          const stepName = t(step.label)
          const before = STEPS[index - 1]
          // What hovering this step tells: the step, what a click does, and the current stage.
          const stepHelp = isCurrent
            ? `${stepName}: ${t("the current stage.")} ${
                before
                  ? `${t("Click to go back to")} ${t(before.label)}.`
                  : t("Click to clear the stage.")
              }`
            : `${stepName}: ${t("click to set.")} ${
                current ? `${t("Current:")} ${t(current.label)}.` : t("Not started yet.")
              }`
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
                aria-current={isCurrent ? "step" : undefined}
                aria-label={isCurrent ? `${label} ${t("(current)")}` : label}
                title={stepName}
                data-feature-label={name}
                data-feature-help={stepHelp}
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
                    isCurrent && "border-foreground bg-foreground ring-2 ring-foreground/20",
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
