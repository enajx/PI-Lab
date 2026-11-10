import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useTRPC } from "../../../trpc/react"

/**
 * Place `shownIds` (the new order of the projects a list shows) into the slots those
 * projects held in `allIds`. Projects the list does not show (hidden ones) keep their slots.
 */
export function mergeShownOrder(allIds: string[], shownIds: string[]): string[] {
  const shown = new Set(shownIds)
  const next = shownIds[Symbol.iterator]()
  return allIds.map((id) => (shown.has(id) ? (next.next().value ?? id) : id))
}

/**
 * Save a new project order from the Dashboard cards or the sidebar list, which share
 * one order. The list cache is updated at once, so the moved card stays where it was
 * dropped, then `projects.reorder` saves it; the list is fetched again afterwards, so a
 * failed save puts the saved order back. `onError` reports the failure.
 */
export function useProjectReorder(
  onError: (message: string) => void,
): (shownIds: string[]) => void {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const listKey = trpc.projects.list.queryKey()
  const reorder = useMutation(
    trpc.projects.reorder.mutationOptions({
      onError: (error) => onError(error.message),
      onSettled: () => queryClient.invalidateQueries({ queryKey: listKey }),
    }),
  )
  return (shownIds: string[]) => {
    const projects = queryClient.getQueryData(listKey)
    if (projects === undefined) return
    const ids = mergeShownOrder(
      projects.map((project) => project.id),
      shownIds,
    )
    // A list fetch already on its way would put the old order back.
    void queryClient.cancelQueries({ queryKey: listKey })
    const byId = new Map(projects.map((project) => [project.id, project]))
    queryClient.setQueryData(
      listKey,
      ids.flatMap((id) => byId.get(id) ?? []),
    )
    reorder.mutate({ ids })
  }
}
