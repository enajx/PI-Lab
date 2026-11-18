import { cn } from "@pi-lab/ui"
import { Link } from "@tanstack/react-router"
import { useTranslate } from "../i18n/language"
import type { ProjectListItem } from "../trpc/types"
import { MachineBadge } from "./MachineControls"
import { type MachineSummary, useMachineState } from "./machines"
import { projectRoute } from "./projectRoute"

/**
 * Projects of remote machines in the Projects Dashboard and the sidebar. They
 * open in the machine's project view. While the machine is disconnected they
 * show greyed with the last list the machine gave.
 */

/** One machine's projects as Dashboard cards (after this Mac's own cards). */
export function RemoteProjectCards({
  machine,
  projects,
}: {
  machine: MachineSummary
  projects: ProjectListItem[]
}) {
  const t = useTranslate()
  const state = useMachineState(machine.machineId)
  const offline = state === "disconnected"
  return projects
    .filter((project) => !project.archivedAt)
    .map((project) => (
      <Link
        key={`${machine.machineId}/${project.id}`}
        {...projectRoute(machine.machineId, project.id)}
        data-testid="remote-project-card"
        data-project-id={project.id}
        data-machine-id={machine.machineId}
        data-offline={offline}
        title={offline ? `${machine.name}: ${t("Disconnected")}` : project.repoPath}
        className={cn(
          "flex min-h-28 flex-col gap-1.5 rounded-xl border border-border bg-card p-2.5 text-start outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
          offline && "opacity-50 grayscale",
        )}
      >
        <span className="w-full min-w-0 truncate font-medium text-foreground text-sm">
          {project.name}
        </span>
        <MachineBadge name={machine.name} className="" />
        <span className="min-w-0 truncate text-muted-foreground text-xs">{project.repoPath}</span>
      </Link>
    ))
}

/** One machine's projects as sidebar rows (after this Mac's own rows). */
export function RemoteProjectRows({
  machine,
  projects,
  collapsed,
  activeProjectId,
}: {
  machine: MachineSummary
  projects: ProjectListItem[]
  collapsed: boolean
  activeProjectId: string | null
}) {
  const t = useTranslate()
  const state = useMachineState(machine.machineId)
  const offline = state === "disconnected"
  return projects
    .filter((project) => !project.archivedAt)
    .map((project) => {
      const active = activeProjectId === project.id
      return (
        <Link
          key={`${machine.machineId}/${project.id}`}
          {...projectRoute(machine.machineId, project.id)}
          data-testid="remote-project-item"
          data-project-id={project.id}
          data-machine-id={machine.machineId}
          data-offline={offline}
          data-active={active}
          title={offline ? `${machine.name}: ${t("Disconnected")}` : project.repoPath}
          className={cn(
            "flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
            collapsed && "justify-center px-0",
            active && "bg-accent text-accent-foreground",
            offline && "opacity-50 grayscale",
          )}
        >
          <span
            aria-hidden
            className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent font-medium text-xs uppercase"
          >
            {project.name.trim().charAt(0) || "?"}
          </span>
          {collapsed ? (
            <span className="sr-only">{project.name}</span>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <MachineBadge name={machine.name} className="" />
            </>
          )}
        </Link>
      )
    })
}
