import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useTRPC } from "../trpc/react"

export type CaffeineMode = "off" | "on" | "auto"
export type CaffeineScope = "system-only" | "system-plus-display"

export interface CaffeineStatus {
  mode: CaffeineMode
  scope: CaffeineScope
  held: boolean
}

const DEFAULT_STATUS: CaffeineStatus = {
  mode: "off",
  scope: "system-only",
  held: false,
}

/**
 * The renderer's one caffeine seam. Header controls and Settings share the same
 * cache, update it optimistically, and periodically reconcile with main so Auto
 * activity changes become visible without making this status read count as work.
 */
export function useCaffeine() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const statusKey = trpc.caffeine.status.queryKey()
  const statusQuery = useQuery({
    ...trpc.caffeine.status.queryOptions(),
    refetchInterval: 30_000,
  })
  const reconcile = () => void queryClient.invalidateQueries({ queryKey: statusKey })
  const setModeMutation = useMutation(
    trpc.caffeine.setMode.mutationOptions({
      onError: reconcile,
      onSuccess: reconcile,
    }),
  )
  const setScopeMutation = useMutation(
    trpc.caffeine.setScope.mutationOptions({
      onError: reconcile,
      onSuccess: reconcile,
    }),
  )
  const status = statusQuery.data ?? DEFAULT_STATUS

  const setMode = (mode: CaffeineMode) => {
    queryClient.setQueryData<CaffeineStatus>(statusKey, {
      ...status,
      mode,
      held: mode === "off" ? false : status.held,
    })
    setModeMutation.mutate({ mode })
  }

  const setScope = (scope: CaffeineScope) => {
    queryClient.setQueryData<CaffeineStatus>(statusKey, { ...status, scope })
    setScopeMutation.mutate({ scope })
  }

  return {
    status,
    setMode,
    setScope,
    isChanging: setModeMutation.isPending || setScopeMutation.isPending,
  }
}
