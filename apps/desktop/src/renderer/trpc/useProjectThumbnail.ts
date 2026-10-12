import type { Project } from "@pi-lab/local-db"
import { useQuery } from "@tanstack/react-query"
import { useTRPC } from "./react"

export type ProjectSummary = Omit<Project, "thumbnail"> & { hasThumbnail: boolean }

/** Fetch only the variant needed by a visible card or sidebar badge. */
export function useProjectThumbnail(
  project: Pick<ProjectSummary, "id" | "hasThumbnail">,
  variant: "card" | "badge",
) {
  const trpc = useTRPC()
  const query = useQuery({
    ...trpc.projects.thumbnail.queryOptions({ id: project.id, variant }),
    enabled: project.hasThumbnail,
  })
  return {
    dataUrl: project.hasThumbnail ? (query.data?.dataUrl ?? null) : null,
    tooLarge: project.hasThumbnail && (query.data?.tooLarge ?? false),
    hasThumbnail: project.hasThumbnail,
  }
}
