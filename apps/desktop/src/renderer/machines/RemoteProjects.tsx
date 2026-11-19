import { cn } from "@pi-lab/ui"
import { Link } from "@tanstack/react-router"
import { ResizableCardGridItem } from "../components/CardGrid"
import { useTranslate } from "../i18n/language"
import { ProjectActivityProvider } from "../routes/_shell/-ProjectActivity"
import { ProjectCard } from "../routes/_shell/index/components/ProjectCard"
import type { ProjectListItem } from "../trpc/types"
import { MachineLabel } from "./MachineControls"
import { MachineScope, type MachineSummary, useMachineState } from "./machines"
import { projectRoute } from "./projectRoute"

/**
 * Projects of remote machines in the Projects Dashboard and the sidebar. They
 * open in the machine's project view. While the machine is disconnected they
 * show greyed with the last list the machine gave.
 */

/**
 * One machine's projects as Dashboard cards (after this Mac's own cards): the
 * same card as a local project, inside the machine's {@link MachineScope}, so
 * its cover, agents line, buttons and milestone dots read and change the
 * project on that machine's server. Not draggable (the saved order is this
 * Mac's).
 */
export function RemoteProjectCards({
  machine,
  projects,
}: {
  machine: MachineSummary
  projects: ProjectListItem[]
}) {
  const state = useMachineState(machine.machineId)
  const offline = state === "disconnected"
  const { machineId } = machine
  const cardMachine = { machineId, name: machine.name, offline }
  return (
    <MachineScope machineId={machineId}>
      <ProjectActivityProvider>
        {projects
          .filter((project) => !project.archivedAt)
          .map((project) => (
            <ResizableCardGridItem
              key={`${machineId}/${project.id}`}
              cardId={`${machineId}/${project.id}`}
              label={project.name}
              testId="remote-project-card"
              data-project-id={project.id}
              data-machine-id={machineId}
              data-offline={offline}
              className={cn("rounded-xl", offline && "opacity-50 grayscale")}
            >
              <ProjectCard project={project} machine={cardMachine} />
            </ResizableCardGridItem>
          ))}
      </ProjectActivityProvider>
    </MachineScope>
  )
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
              <MachineLabel name={machine.name} offline={offline} />
            </>
          )}
        </Link>
      )
    })
}
