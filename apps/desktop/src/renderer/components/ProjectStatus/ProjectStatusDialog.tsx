import { useQuery } from "@tanstack/react-query"
import { useEffect } from "react"
import { createPortal } from "react-dom"
import { useInterfaceLanguage, useTranslate } from "../../i18n/language"
import {
  DEFAULT_EXPERIMENT_RUNS_FILE,
  useExperimentRunsFile,
  useExperimentRunsSource,
} from "../../preferences/preferences"
import { useAgentStatus, useProjectActivityState } from "../../routes/_shell/-ProjectActivity"
import { Markdown } from "../../routes/_shell/projects/components/RightSidebar/components/Markdown"
import { useTRPC } from "../../trpc/react"
import { elapsedSince } from "../elapsed"
import { ProjectWorkflowControl } from "../ProjectWorkflow"

/**
 * How long ago `then` was, as a localized phrase: "just now" under a minute,
 * else "5 minutes ago", "2 hours ago", "3 days ago".
 */
export function formatTimeAgo(
  then: number,
  now: number,
  language: string,
  justNow: string,
): string {
  const elapsed = elapsedSince(then, now)
  if (elapsed.unit === "now") return justNow
  return new Intl.RelativeTimeFormat(language, { numeric: "always" }).format(
    -elapsed.count,
    elapsed.unit,
  )
}

/**
 * The Project status card: a small centered dialog (same frame as the workflow
 * result window) showing, without running any agent:
 *   - the last activity: the most recent of when the project was last opened,
 *     its agents' last activity (`sessions.projectAgents`, plus "now" while an
 *     agent works on it), and its background workflows' last runs;
 *   - the experiment run counts (running / finished / failed, plus every other
 *     status word) from the experiments file set in Settings > Remote
 *     experiments (`science.experiments.status`), or "No <file>" when missing;
 *   - how many agents are live in the project (working or waiting, any view,
 *     from the shared `sessions.onStatus` stream) and how many of its tasks are
 *     open (not done, from `science.tasks.list`);
 *   - the stored project summary (the last result of the summary workflow) as
 *     Markdown, with the agent that wrote it and when, or "No project summary
 *     yet"; a failed last run shows its error;
 *   - a "Generate project summary" button, the shared summary workflow control
 *     (same run, live window, error and Git-required behaviour). The card reads
 *     the same `workflows.status` query, so it updates when the run finishes.
 * Closes on Escape (unless the run's own window is open on top), a backdrop
 * click, or the Close button.
 */
export function ProjectStatusDialog({
  projectId,
  projectName,
  lastOpenedAt,
  gitAvailable,
  gitDisabledReason,
  onClose,
}: {
  projectId: string
  projectName: string
  lastOpenedAt: number
  gitAvailable: boolean
  gitDisabledReason: string
  onClose: () => void
}) {
  const t = useTranslate()
  const [language] = useInterfaceLanguage()
  const trpc = useTRPC()
  const activityState = useProjectActivityState(projectId)
  const statusQuery = useQuery(
    trpc.workflows.status.queryOptions(
      { projectId },
      {
        staleTime: 0,
        refetchInterval: (query) => (query.state.data?.summary?.running ? 800 : false),
      },
    ),
  )
  const agentsQuery = useQuery(
    trpc.sessions.projectAgents.queryOptions({ projectId }, { staleTime: 0 }),
  )
  const liveAgents = useAgentStatus()
  const [runsSource] = useExperimentRunsSource()
  const [runsFile] = useExperimentRunsFile()
  const runsRelPath = runsFile.trim() || DEFAULT_EXPERIMENT_RUNS_FILE
  const runsQuery = useQuery(
    trpc.science.experiments.status.queryOptions(
      { projectId, source: { kind: runsSource, relPath: runsRelPath } },
      { staleTime: 0 },
    ),
  )
  const runs = runsQuery.data
  const tasksQuery = useQuery(trpc.science.tasks.list.queryOptions(undefined, { staleTime: 0 }))
  const activeAgents = (liveAgents.data ?? []).filter(
    (agent) => agent.projectId === projectId,
  ).length
  const openTasks = (tasksQuery.data?.tasks ?? []).filter(
    (task) => task.projectId === projectId && task.status !== "done",
  ).length

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      // Escape first closes the summary run's window when it is open on top.
      if (document.querySelector("[data-testid='workflow-result-dialog']")) return
      onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  const now = Date.now()
  const status = statusQuery.data
  const workflowTimes = [
    status?.summary,
    status?.planResearch,
    status?.fetchExperiments,
    status?.latexMerge,
  ].map((record) => record?.lastCheckedAt ?? 0)
  const agentTimes = (agentsQuery.data ?? []).map((row) => row.lastActiveAt)
  const lastActivity = Math.max(
    lastOpenedAt,
    ...workflowTimes,
    ...agentTimes,
    activityState === "active" ? now : 0,
  )
  const summary = status?.summary ?? null
  const justNow = t("just now")

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is a click-to-dismiss surface; Escape (bound above) is the keyboard equivalent.
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismissal mirrors Escape, which is already handled.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${projectName} — ${t("Project status")}`}
        data-testid="project-status-dialog"
        className="flex max-h-full w-full max-w-[420px] flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xl"
      >
        <div className="border-border border-b px-3 py-2">
          <h2 className="font-medium text-foreground text-sm">{t("Project status")}</h2>
          <p className="truncate text-muted-foreground text-xs">{projectName}</p>
        </div>

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-3 py-3">
          <p data-testid="project-status-last-activity" className="text-foreground text-sm">
            <span className="text-muted-foreground">{t("Last activity:")}</span>{" "}
            {lastActivity > 0
              ? formatTimeAgo(lastActivity, now, language, justNow)
              : t("No activity yet")}
          </p>
          <p data-testid="project-status-experiment-runs" className="text-foreground text-sm">
            <span className="text-muted-foreground">{t("Experiment runs:")}</span>{" "}
            {runsQuery.isError
              ? `${t("Could not read experiment runs:")} ${runsQuery.error.message}`
              : !runs
                ? t("Loading…")
                : !runs.found
                  ? `${t("No")} ${runs.relPath}`
                  : `${runs.running} ${t("running")}, ${runs.finished} ${t("finished")}, ${runs.failed} ${t("failed")}${
                      runs.other.length > 0
                        ? `; ${t("other:")} ${runs.other.map((entry) => `${entry.count} ${entry.status}`).join(", ")}`
                        : ""
                    }`}
          </p>
          <p data-testid="project-status-active-agents" className="text-foreground text-sm">
            <span className="text-muted-foreground">{t("Active agents:")}</span>{" "}
            {liveAgents.error
              ? `${t("Could not read agent status:")} ${liveAgents.error.message}`
              : liveAgents.data === undefined
                ? t("Loading…")
                : activeAgents}
          </p>
          <p data-testid="project-status-open-tasks" className="text-foreground text-sm">
            <span className="text-muted-foreground">{t("Open tasks:")}</span>{" "}
            {tasksQuery.isError
              ? `${t("Could not read tasks:")} ${tasksQuery.error.message}`
              : tasksQuery.isPending
                ? t("Loading…")
                : openTasks}
          </p>

          <section className="flex flex-col gap-2">
            <h3 className="font-medium text-foreground text-sm">{t("Project summary")}</h3>
            {statusQuery.isError ? (
              <p role="alert" className="text-destructive text-sm">
                {t("Could not read the project summary:")} {statusQuery.error.message}
              </p>
            ) : statusQuery.isPending ? (
              <p className="text-muted-foreground text-sm">{t("Loading…")}</p>
            ) : summary?.errorMessage ? (
              <p
                data-testid="project-status-summary-error"
                className="cursor-text select-text whitespace-pre-wrap text-destructive text-sm"
              >
                {t("The last summary update failed:")} {summary.errorMessage}
              </p>
            ) : summary?.result ? (
              <>
                <div data-testid="project-status-summary">
                  <Markdown content={summary.result} />
                </div>
                <p
                  data-testid="project-status-summary-author"
                  className="text-muted-foreground text-xs"
                >
                  {summary.agentLabel
                    ? `${t("Written by")} ${summary.agentLabel}, ${formatTimeAgo(summary.lastCheckedAt, now, language, justNow)}`
                    : `${t("Written")} ${formatTimeAgo(summary.lastCheckedAt, now, language, justNow)}`}
                </p>
              </>
            ) : (
              <p data-testid="project-status-no-summary" className="text-muted-foreground text-sm">
                {t("No project summary yet")}
              </p>
            )}
          </section>
        </div>

        <div className="flex items-center justify-end gap-2 border-border border-t px-3 py-2">
          <ProjectWorkflowControl
            projectId={projectId}
            projectName={projectName}
            task="summary"
            variant="labeled"
            testId="project-status-update-summary"
            label={t("Generate project summary")}
            disabled={!gitAvailable}
            disabledReason={gitAvailable ? undefined : gitDisabledReason}
          />
          <button
            type="button"
            data-testid="project-status-close"
            onClick={onClose}
            className="rounded-md bg-brand px-3 py-1.5 font-medium text-brand-foreground text-sm transition-colors hover:bg-brand/90"
          >
            {t("Close")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
