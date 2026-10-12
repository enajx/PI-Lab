import { createFileRoute } from "@tanstack/react-router"
import { projectNotificationSearchSchema } from "../../../notifications/activation"
import { ProjectWorkspace } from "./-ProjectWorkspace"

/**
 * Project route (md/02; plan "Settings panel, project-view rework") — the rich
 * workspace surface a project card opens directly into. The central panel holds
 * whatever the user opens (an agent, a plain terminal, or a file in the built-in
 * editor) as tabs; the right sidebar (Research / TODOs / Files, + an optional
 * Code changes panel) sits alongside it, and can be collapsed away to give the
 * central panel the full width (a slim affordance brings it back).
 *
 * TanStack reuses the route component across `/projects/A → /projects/B`, so the
 * actual view is keyed on `projectId` ({@link ProjectWorkspace}) — a fresh mount
 * per project resets the central panel's open tabs/sessions and editor buffers so
 * one project's state never leaks into another.
 */
export const Route = createFileRoute("/_shell/projects/$projectId")({
  validateSearch: (search) => projectNotificationSearchSchema.parse(search),
  component: ProjectRoute,
})

function ProjectRoute() {
  const { projectId } = Route.useParams()
  const activation = Route.useSearch()
  return <ProjectWorkspace key={projectId} projectId={projectId} activation={activation} />
}
