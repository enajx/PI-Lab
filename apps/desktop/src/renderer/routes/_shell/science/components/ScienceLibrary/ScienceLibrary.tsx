import { Button } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { LogOut } from "lucide-react"
import { useLayoutEffect, useRef, useState } from "react"
import { EdgeResizeHandle } from "../../../../../components/EdgeResizeHandle"
import { useTranslate } from "../../../../../i18n/language"
import { useTRPC } from "../../../../../trpc/react"
import { ScienceTabShell } from "../ScienceTabShell"
import { LibraryBrowser } from "./components/LibraryBrowser"
import { LibrarySourceChooser, type LibrarySourceValues } from "./components/LibrarySourceChooser"
import { LibraryViewer } from "./components/LibraryViewer"
import { useLibraryTabs } from "./libraryTabs"

/** Narrowest the list or the viewer may be dragged to, in px. */
const MIN_PANE_WIDTH = 280

/** Display name of a folder source: its last path segment, for the breadcrumb root. */
function folderName(folderPath: string): string {
  const segments = folderPath.split(/[/\\]+/).filter(Boolean)
  return segments[segments.length - 1] ?? folderPath
}

/**
 * Library science tab — v1 is **connect +
 * browse**: connect a library source (a Zotero library via the local desktop API or
 * cloud Web API, or a local folder of PDFs — all stored locally) and browse it as a
 * **collections browser** (collections by default, drill into a collection's items).
 *
 * When not connected the tab shows the source chooser; once connected it shows the
 * browser with a disconnect affordance. The list stays centered until a paper opens in a
 * viewer tab; then the list moves left and the viewer shows on the right, with a drag
 * handle between them (the list starts at half the width). Tabs are kept per source and
 * remembered across restarts; closing the last one returns to the centered layout. The
 * list keeps the same element position in both layouts, so its navigation state survives.
 * The body owns its own scroll per AGENTS.md Pitfalls #3.
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

  const viewerTabs = useLibraryTabs(
    status?.kind === "folder"
      ? `folder:${status.folderPath ?? ""}`
      : `zotero:${status?.mode ?? ""}:${status?.libraryType ?? ""}:${status?.libraryId ?? ""}`,
  )
  const split = connected && viewerTabs.tabs.length > 0
  const bodyRef = useRef<HTMLDivElement>(null)
  const [bodyWidth, setBodyWidth] = useState(0)
  // The list's dragged width in px; null until the user drags (then the list is half the width).
  const [listWidth, setListWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const observer = new ResizeObserver(() => setBodyWidth(body.clientWidth))
    observer.observe(body)
    setBodyWidth(body.clientWidth)
    return () => observer.disconnect()
  }, [])
  const maxListWidth = Math.max(MIN_PANE_WIDTH, bodyWidth - MIN_PANE_WIDTH)
  const drawnListWidth = Math.min(listWidth ?? bodyWidth / 2, maxListWidth)

  return (
    <ScienceTabShell
      layout={split ? "cards" : "flush"}
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
      <div ref={bodyRef} className={split ? "flex min-h-0 flex-1 gap-3" : "flex min-h-0 flex-1"}>
        {/* Split: the list and the viewer are separate rounded cards 12px apart, with the
            drag handle in the gap. The scroller keeps its element position in both layouts. */}
        <div
          className={split ? "relative flex min-h-0 shrink-0" : "flex min-h-0 flex-1"}
          style={split ? { width: drawnListWidth } : undefined}
        >
          {split ? (
            <EdgeResizeHandle
              side="right"
              width={drawnListWidth}
              min={MIN_PANE_WIDTH}
              max={maxListWidth}
              onResize={setListWidth}
              testId="library-split-handle"
            />
          ) : null}
          <div
            data-testid="library-list-pane"
            data-split={split || undefined}
            className={
              split
                ? "min-h-0 min-w-0 flex-1 overflow-y-auto rounded-lg border border-panel-border"
                : "min-h-0 flex-1 overflow-y-auto"
            }
          >
            <div
              className={
                split
                  ? "flex w-full flex-col p-3"
                  : "mx-auto flex w-full max-w-3xl flex-col gap-8 p-6"
              }
            >
              {/* Source chooser, or the connected collections browser. */}
              {connected ? (
                <LibraryBrowser
                  kind={kind}
                  canWrite={canWrite}
                  rootLabel={rootLabel}
                  onOpenTab={viewerTabs.open}
                />
              ) : (
                <LibrarySourceChooser
                  onConnect={onConnect}
                  isPending={connect.isPending}
                  error={connect.error?.message ?? null}
                />
              )}
            </div>
          </div>
        </div>
        {split ? (
          <LibraryViewer
            tabs={viewerTabs.tabs}
            activeId={viewerTabs.activeId}
            kind={kind}
            onActivate={viewerTabs.activate}
            onClose={viewerTabs.close}
          />
        ) : null}
      </div>
    </ScienceTabShell>
  )
}
