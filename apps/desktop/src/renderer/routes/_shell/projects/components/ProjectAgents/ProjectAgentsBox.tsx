import type { WorkflowTask } from "@pi-lab/local-db"
import { cn } from "@pi-lab/ui"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { ChartArea, ListTodo, Repeat, Waypoints } from "lucide-react"
import { useRef, useState } from "react"
import type { ProjectAgentRow, ProjectAgentStatus } from "../../../../../../shared/projectAgents"
import { elapsedSince } from "../../../../../components/elapsed"
import { LatexLogo } from "../../../../../components/LatexText"
import { ProjectWorkflowDialog, workflowTaskLabel } from "../../../../../components/ProjectWorkflow"
import { useTranslate } from "../../../../../i18n/language"
import { navigateToAgent } from "../../../../../notifications/agentNavigation"
import { useTRPC } from "../../../../../trpc/react"

/** How often the box re-reads the project's agents (ms). */
const REFRESH_MS = 1_000

const STATUS_LABELS: Record<ProjectAgentStatus, string> = {
  working: "working",
  waiting: "waiting for input",
  done: "done",
  failed: "failed",
}

/**
 * The last-active time as a short relative phrase: "now" (under a minute),
 * "5m ago", "2h ago", "1 day ago", "7 days ago".
 */
export function formatLastActive(lastActiveAt: number, now: number): string {
  const elapsed = elapsedSince(lastActiveAt, now)
  if (elapsed.unit === "now") return "now"
  if (elapsed.unit === "minute") return `${elapsed.count}m ago`
  if (elapsed.unit === "hour") return `${elapsed.count}h ago`
  return elapsed.count === 1 ? "1 day ago" : `${elapsed.count} days ago`
}

/**
 * The Project view's "Project Agents" box: the project's live agents started
 * outside the Project view (LaTeX Editor, Analysis, Tasks, routines) and its
 * running background workflow runs. Hidden when there are none. Clicking an agent
 * opens its view on this project with its tab focused (a routine's agent opens as
 * a tab here); clicking a background run opens its result window.
 */
export function ProjectAgentsBox({
  projectId,
  projectName,
  className,
}: {
  projectId: string
  projectName: string
  className: string
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const navigate = useNavigate()
  const [openTask, setOpenTask] = useState<WorkflowTask | null>(null)
  const requests = useRef(0)
  const query = useQuery(
    trpc.sessions.projectAgents.queryOptions(
      { projectId },
      { staleTime: 0, refetchInterval: REFRESH_MS },
    ),
  )
  const rows = query.data ?? []

  const open = (row: ProjectAgentRow): void => {
    if (row.kind === "background") {
      setOpenTask(row.task)
      return
    }
    requests.current += 1
    navigateToAgent(
      navigate,
      {
        projectId,
        workspaceId: row.workspaceId,
        sessionId: row.sessionId,
        agentId: row.agentId,
        origin: row.origin,
        label: row.name,
      },
      `project-agents-${requests.current}`,
    )
  }

  const dialog = openTask ? (
    <ProjectWorkflowDialog
      projectId={projectId}
      projectName={projectName}
      task={openTask}
      onClose={() => setOpenTask(null)}
    />
  ) : null

  if (query.isError) {
    return (
      <p
        role="alert"
        data-testid="project-agents-error"
        className={cn("cursor-text select-text text-destructive text-xs", className)}
      >
        {t("Could not list project agents:")} {query.error.message}
      </p>
    )
  }
  if (rows.length === 0) return dialog

  const now = Date.now()
  return (
    <section
      data-testid="project-agents-box"
      aria-label={t("Project Agents")}
      className={cn("rounded-md border border-border bg-background p-2", className)}
    >
      <h2 className="px-1 pb-1 font-semibold text-foreground text-xs">{t("Project Agents")}</h2>
      <ul className="flex flex-col">
        {rows.map((row) => {
          const name = row.kind === "agent" ? row.name : t(workflowTaskLabel(row.task))
          const origin = row.kind === "agent" ? row.origin : "background"
          return (
            <li key={row.kind === "agent" ? row.sessionId : `workflow:${row.task}`}>
              <button
                type="button"
                data-testid="project-agent-row"
                data-origin={origin}
                onClick={() => open(row)}
                className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-accent/60"
              >
                <span className="flex w-8 shrink-0 justify-center text-muted-foreground">
                  {origin === "latex" ? (
                    <LatexLogo />
                  ) : origin === "analysis" ? (
                    <ChartArea className="size-3.5" aria-label={t("Analysis")} />
                  ) : origin === "tasks" ? (
                    <ListTodo className="size-3.5" aria-label={t("Tasks")} />
                  ) : origin === "routine" ? (
                    <Repeat className="size-3.5" aria-label={t("Routine")} />
                  ) : (
                    <Waypoints className="size-3.5" aria-label={t("Background routine")} />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground">{name}</span>
                <span className="shrink-0 text-muted-foreground">
                  {t(STATUS_LABELS[row.status])}
                </span>
                <span className="w-16 shrink-0 text-right text-muted-foreground/60">
                  {row.status === "working" ? t("now") : formatLastActive(row.lastActiveAt, now)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {dialog}
    </section>
  )
}
