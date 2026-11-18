import {
  PROJECT_CARD_BUTTONS,
  type ProjectCardButton,
  shownProjectCardButtons,
} from "@pi-lab/local-db/editor-settings"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useMemo } from "react"
import { useTRPC } from "./react"

/**
 * The Projects Dashboard card buttons the user chose in Settings > Dashboard,
 * read from `settings.editor.projectCardButtons` (the default while loading or
 * when never saved), and a setter for one button. A change saves the full list
 * in card order and updates the cached settings first, so quick clicks on
 * several switches build on each other. A failed save returns its message;
 * the refetch then shows the saved list again.
 */
export function useProjectCardButtons(): [
  ReadonlySet<ProjectCardButton>,
  (button: ProjectCardButton, shown: boolean) => void,
  string | null,
] {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const settingsQuery = useQuery(trpc.settings.get.queryOptions())
  const saved = settingsQuery.data?.editor?.projectCardButtons
  const shown = useMemo(() => new Set(shownProjectCardButtons(saved)), [saved])
  const update = useMutation(
    trpc.settings.updateEditor.mutationOptions({
      onSettled: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() }),
    }),
  )
  const mutate = update.mutate
  const setShown = useCallback(
    (button: ProjectCardButton, next: boolean) => {
      const key = trpc.settings.get.queryKey()
      const current = new Set(
        shownProjectCardButtons(queryClient.getQueryData(key)?.editor?.projectCardButtons),
      )
      const projectCardButtons = PROJECT_CARD_BUTTONS.filter((id) =>
        id === button ? next : current.has(id),
      )
      queryClient.setQueryData(key, (old) =>
        old ? { ...old, editor: { ...old.editor, projectCardButtons } } : old,
      )
      mutate({ projectCardButtons })
    },
    [mutate, queryClient, trpc],
  )
  return [shown, setShown, update.error?.message ?? null]
}
