import { Button } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { LogOut } from "lucide-react"
import { useTranslate } from "../../../../../i18n/language"
import { useTRPC } from "../../../../../trpc/react"
import { ScienceTabShell } from "../ScienceTabShell"
import { LibraryBrowser } from "./components/LibraryBrowser"
import { LibrarySourceChooser, type LibrarySourceValues } from "./components/LibrarySourceChooser"

/** Display name of a folder source: its last path segment, for the breadcrumb root. */
function folderName(folderPath: string): string {
  const segments = folderPath.split(/[/\\]+/).filter(Boolean)
  return segments[segments.length - 1] ?? folderPath
}

/**
 * Library science tab (AGENTS.md "Scope" "Science tabs", P8d) — v1 is **connect +
 * browse**: connect a library source (a Zotero library via the local desktop API or
 * cloud Web API, or a local folder of PDFs — all stored locally) and browse it as a
 * **collections browser** (collections by default, drill into a collection's items).
 *
 * When not connected the tab shows the source chooser; once connected it shows the
 * browser with a disconnect affordance. The body owns its own scroll per AGENTS.md
 * Pitfalls #3.
 */
export function ScienceLibrary() {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const statusQuery = useQuery(trpc.science.library.getStatus.queryOptions())
  const status = statusQuery.data
  const connected = status?.connected ?? false
  const canWrite = status?.canWrite ?? false
  const kind = status?.kind ?? "zotero"
  const rootLabel =
    status?.kind === "folder" && status.folderPath
      ? folderName(status.folderPath)
      : t("Zotero library")

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.science.library.getStatus.queryKey() })
    void queryClient.invalidateQueries({
      queryKey: trpc.science.library.listCollections.queryKey(),
    })
    void queryClient.invalidateQueries({ queryKey: trpc.science.library.listItems.queryKey() })
  }

  const connect = useMutation(
    trpc.science.library.connect.mutationOptions({ onSuccess: () => invalidate() }),
  )
  const disconnect = useMutation(
    trpc.science.library.disconnect.mutationOptions({ onSuccess: () => invalidate() }),
  )

  const onConnect = (values: LibrarySourceValues) => connect.mutate(values)

  return (
    <ScienceTabShell
      testId="science-library"
      title={t("Library")}
      subtitle={t("Browse your Zotero library or a folder of PDFs")}
      actions={
        connected ? (
          <Button
            data-testid="library-disconnect"
            data-feature-label={t("Disconnect library")}
            data-feature-help={t(
              "Disconnect this library source so you can choose a different Zotero library or PDF folder.",
            )}
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-muted-foreground"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            <LogOut />
            {t("Disconnect")}
          </Button>
        ) : null
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6">
          {/* Source chooser, or the connected collections browser. */}
          {connected ? (
            <LibraryBrowser kind={kind} canWrite={canWrite} rootLabel={rootLabel} />
          ) : (
            <LibrarySourceChooser
              onConnect={onConnect}
              isPending={connect.isPending}
              error={connect.error?.message ?? null}
            />
          )}
        </div>
      </div>
    </ScienceTabShell>
  )
}
