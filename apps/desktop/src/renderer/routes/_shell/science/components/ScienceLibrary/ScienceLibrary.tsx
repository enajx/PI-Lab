import { Button } from "@skipper/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Library, LogOut, RefreshCw } from "lucide-react"
import { useTRPC } from "../../../../../trpc/react"
import { ScienceTabShell } from "../ScienceTabShell"
import { LibraryItem } from "./components/LibraryItem"
import { ScholarSearch } from "./components/ScholarSearch"
import { ZoteroConnectForm, type ZoteroConnectValues } from "./components/ZoteroConnectForm"

/**
 * Library science tab (AGENTS.md §1 "Science tabs", P8d) — v1 is **connect +
 * browse + look up**: connect a Zotero library (credentials stored locally),
 * browse its items as paper cards, and search Semantic Scholar for papers. Deep
 * two-way sync, citation export, and paper recommendations are explicitly v2.
 *
 * When not connected the tab shows the Zotero connect form; once connected it
 * shows the library list with a disconnect affordance. The Semantic Scholar
 * search is always available (no Zotero key required). The body owns its own
 * scroll per §12.3.
 */
export function ScienceLibrary() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const statusQuery = useQuery(trpc.science.library.getStatus.queryOptions())
  const connected = statusQuery.data?.connected ?? false

  const itemsQuery = useQuery({
    ...trpc.science.library.listItems.queryOptions({}),
    enabled: connected,
    staleTime: 30_000,
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.science.library.getStatus.queryKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.science.library.listItems.queryKey() })
  }

  const connect = useMutation(
    trpc.science.library.connect.mutationOptions({ onSuccess: () => invalidate() }),
  )
  const disconnect = useMutation(
    trpc.science.library.disconnect.mutationOptions({ onSuccess: () => invalidate() }),
  )

  const onConnect = (values: ZoteroConnectValues) => connect.mutate(values)

  const items = itemsQuery.data?.ok ? itemsQuery.data.items : []
  const itemsError =
    itemsQuery.data && !itemsQuery.data.ok && itemsQuery.data.reason === "error"
      ? itemsQuery.data.message
      : null

  return (
    <ScienceTabShell
      testId="science-library"
      title="Library"
      subtitle="Browse your Zotero library and look up papers on Semantic Scholar"
      actions={
        connected ? (
          <Button
            data-testid="zotero-disconnect"
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-muted-foreground"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            <LogOut />
            Disconnect
          </Button>
        ) : null
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6">
          {/* Zotero section: connect form, or the connected library list. */}
          {connected ? (
            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                  Zotero library
                </span>
                <Button
                  data-testid="library-refresh"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 text-muted-foreground text-xs"
                  disabled={itemsQuery.isFetching}
                  onClick={() =>
                    queryClient.invalidateQueries({
                      queryKey: trpc.science.library.listItems.queryKey(),
                    })
                  }
                >
                  <RefreshCw className="size-3.5" />
                  {itemsQuery.isFetching ? "Refreshing…" : "Refresh"}
                </Button>
              </div>

              {itemsError ? (
                <p
                  data-testid="library-error"
                  className="cursor-text select-text text-destructive text-xs"
                >
                  {itemsError}
                </p>
              ) : itemsQuery.isLoading ? (
                <p className="text-muted-foreground text-xs">Loading library…</p>
              ) : items.length === 0 ? (
                <LibraryEmptyState />
              ) : (
                <div className="flex flex-col gap-2">
                  {items.map((paper) => (
                    <LibraryItem key={paper.id} paper={paper} testId="library-item" />
                  ))}
                </div>
              )}
            </section>
          ) : (
            <ZoteroConnectForm
              onSubmit={onConnect}
              isPending={connect.isPending}
              error={connect.error?.message ?? null}
            />
          )}

          {/* Semantic Scholar search — always available (no Zotero key needed). */}
          <section className="flex flex-col gap-3 border-border border-t pt-6">
            <span className="font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider">
              Semantic Scholar
            </span>
            <ScholarSearch />
          </section>
        </div>
      </div>
    </ScienceTabShell>
  )
}

/** Shown when the connected library returned no items. */
function LibraryEmptyState() {
  return (
    <div
      data-testid="science-library-empty"
      className="flex flex-col items-center gap-3 rounded-lg border border-border border-dashed p-10 text-center"
    >
      <Library className="size-7 text-muted-foreground" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="font-medium text-foreground text-sm">No items in this library</p>
        <p className="max-w-xs text-muted-foreground text-xs leading-relaxed">
          Add references to your Zotero library and refresh to see them here.
        </p>
      </div>
    </div>
  )
}
