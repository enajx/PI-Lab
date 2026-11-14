import { Button, cn } from "@pi-lab/ui"
import { useMutation, useQuery } from "@tanstack/react-query"
import { ExternalLink, Globe, X } from "lucide-react"
import { lazy, Suspense, useEffect, useRef, useState } from "react"
import type { ViewerKind } from "../../../../../../../../main/trpc/science/library"
import { useTranslate } from "../../../../../../../i18n/language"
import { registerCloseTabHandler } from "../../../../../../../shortcuts/closeTab"
import { useTRPC, useTRPCClient } from "../../../../../../../trpc/react"
import { Markdown } from "../../../../../projects/components/RightSidebar/components/Markdown"
import type { ViewerTab } from "../../libraryTabs"

const PdfViewer = lazy(() =>
  import("../../../../../../../Editor/components/PdfViewer/PdfViewer").then((module) => ({
    default: module.PdfViewer,
  })),
)

interface LibraryViewerProps {
  tabs: ViewerTab[]
  activeId: string | null
  /** Source kind — picks the "Open in default app" call for files the viewer cannot show. */
  kind: "zotero" | "folder"
  onActivate: (id: string) => void
  onClose: (id: string) => void
}

/**
 * The Library's right-side viewer: a tab strip and the open tabs. A file tab resolves its
 * library item to a local file (`science.library.resolveFile`) and shows a PDF in the bundled
 * PDF.js viewer, HTML in a sandboxed frame with scripts off, Markdown rendered, and any other
 * file as a message with "Open in default app". A file over the viewer's size limit shows its
 * size with "Load anyway" and "Open in default app". A URL tab loads the page in a plain iframe.
 *
 * A tab stays mounted (hidden) once shown, so switching back is instant. Tabs shrink to fit one
 * row. ⌘W closes the active tab and ⌘1–⌘9 switch to the Nth tab. Marked `data-library-viewer`
 * so the Library's list keys leave it alone while it has focus.
 */
export function LibraryViewer({ tabs, activeId, kind, onActivate, onClose }: LibraryViewerProps) {
  const t = useTranslate()
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0]
  // Tabs shown at least once since the viewer mounted; they stay mounted while open.
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set())
  if (active && !shown.has(active.id)) setShown(new Set([...shown, active.id]))

  const latest = useRef({ tabs, active, onActivate, onClose })
  latest.current = { tabs, active, onActivate, onClose }
  // Cmd+W (native menu) closes the active tab; this view owns it while mounted.
  useEffect(
    () =>
      registerCloseTabHandler(() => {
        const current = latest.current.active
        if (!current) return false
        latest.current.onClose(current.id)
        return true
      }),
    [],
  )
  // ⌘1–⌘9 switch to the Nth tab.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      if (!/^[1-9]$/.test(event.key)) return
      const tab = latest.current.tabs[Number(event.key) - 1]
      if (!tab) return
      event.preventDefault()
      latest.current.onActivate(tab.id)
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [])

  return (
    <section
      data-testid="library-viewer"
      data-library-viewer
      tabIndex={-1}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-panel-border focus:outline-none"
    >
      <div role="tablist" className="flex shrink-0 gap-1 border-border border-b px-2 pt-2">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            data-testid="library-viewer-tab"
            data-active={tab.id === active?.id || undefined}
            className={cn(
              "flex min-w-0 max-w-[14rem] flex-1 items-center gap-1 rounded-t-md border border-b-0 px-2 py-1 text-xs",
              tab.id === active?.id
                ? "border-border bg-background text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === active?.id}
              title={tab.title}
              onClick={() => onActivate(tab.id)}
              className="flex min-w-0 flex-1 items-center gap-1"
            >
              {tab.type === "url" ? <Globe className="size-3 shrink-0" aria-hidden /> : null}
              <span className="truncate">{tab.title}</span>
            </button>
            <button
              type="button"
              data-testid="library-viewer-tab-close"
              aria-label={t("Close tab")}
              onClick={() => onClose(tab.id)}
              className="shrink-0 rounded p-0.5 hover:bg-accent"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
      </div>
      {tabs
        .filter((tab) => shown.has(tab.id) || tab.id === active?.id)
        .map((tab) => (
          <div
            key={tab.id}
            className={cn("min-h-0 flex-1 flex-col", tab.id === active?.id ? "flex" : "hidden")}
          >
            {tab.type === "file" ? (
              <FileTab itemId={tab.itemId} kind={kind} />
            ) : (
              <UrlTab url={tab.url} title={tab.title} />
            )}
          </div>
        ))}
    </section>
  )
}

/** A library item's local file, shown by its kind. */
function FileTab({ itemId, kind }: { itemId: string; kind: "zotero" | "folder" }) {
  const t = useTranslate()
  const trpc = useTRPC()
  const resolved = useQuery(trpc.science.library.resolveFile.queryOptions({ itemId }))
  const [allowLarge, setAllowLarge] = useState(false)
  if (resolved.isPending) return <ViewerMessage text={t("Loading…")} />
  if (resolved.error) return <ViewerMessage text={resolved.error.message} error />
  const result = resolved.data
  if (!result.ok) return <ViewerMessage text={result.message} error />
  if (!allowLarge && result.limitBytes !== null && result.size > result.limitBytes) {
    return (
      <LargeFile
        size={result.size}
        limitBytes={result.limitBytes}
        itemId={itemId}
        kind={kind}
        onLoadAnyway={() => setAllowLarge(true)}
      />
    )
  }
  return (
    <FileBody
      path={result.path}
      fileKind={result.kind}
      itemId={itemId}
      kind={kind}
      allowLarge={allowLarge}
    />
  )
}

function FileBody({
  path,
  fileKind,
  itemId,
  kind,
  allowLarge,
}: {
  path: string
  fileKind: ViewerKind
  itemId: string
  kind: "zotero" | "folder"
  allowLarge: boolean
}) {
  const t = useTranslate()
  const client = useTRPCClient()
  if (fileKind === "pdf") {
    return (
      <div data-testid="library-viewer-pdf" className="flex min-h-0 flex-1 flex-col">
        <Suspense fallback={<ViewerMessage text={t("Loading PDF viewer…")} />}>
          <PdfViewer
            source={{
              stat: () => client.science.library.fileStat.query({ path }),
              read: () => client.science.library.readPdf.query({ path, allowLarge }),
              reverseSync: null,
            }}
            sourceKey={path}
            relPath={path}
            location={null}
            onSource={() => undefined}
            build={null}
            onMessage={() => undefined}
          />
        </Suspense>
      </div>
    )
  }
  if (fileKind === "html" || fileKind === "markdown") {
    return <TextBody path={path} fileKind={fileKind} allowLarge={allowLarge} />
  }
  return <OtherFile itemId={itemId} kind={kind} />
}

/** HTML in a sandboxed frame (scripts off), or Markdown rendered. */
function TextBody({
  path,
  fileKind,
  allowLarge,
}: {
  path: string
  fileKind: "html" | "markdown"
  allowLarge: boolean
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const text = useQuery(trpc.science.library.readText.queryOptions({ path, allowLarge }))
  if (text.isPending) return <ViewerMessage text={t("Loading…")} />
  if (text.error) return <ViewerMessage text={text.error.message} error />
  if (fileKind === "html") {
    return (
      <iframe
        data-testid="library-viewer-html"
        title={t("Saved web page")}
        sandbox=""
        srcDoc={text.data}
        className="min-h-0 flex-1 bg-white"
      />
    )
  }
  return (
    <div data-testid="library-viewer-markdown" className="min-h-0 flex-1 overflow-y-auto p-6">
      <Markdown content={text.data} />
    </div>
  )
}

/** Open a library item's local copy in the OS default app; `error` holds a failure message. */
function useOpenInDefaultApp(
  itemId: string,
  kind: "zotero" | "folder",
): { open: () => void; error: string | null } {
  const t = useTranslate()
  const trpc = useTRPC()
  const openItem = useMutation(trpc.science.library.openItem.mutationOptions())
  const openZoteroItem = useMutation(trpc.science.library.openZoteroItem.mutationOptions())
  const [error, setError] = useState<string | null>(null)
  const open = async () => {
    setError(null)
    const result =
      kind === "folder"
        ? await openItem.mutateAsync({ path: itemId })
        : await openZoteroItem.mutateAsync({ itemKey: itemId })
    if (!result.ok) setError(result.message ?? t("Couldn't open the file."))
  }
  return { open: () => void open(), error }
}

/** A file over the viewer's size limit: its size, "Load anyway" and "Open in default app". */
function LargeFile({
  size,
  limitBytes,
  itemId,
  kind,
  onLoadAnyway,
}: {
  size: number
  limitBytes: number
  itemId: string
  kind: "zotero" | "folder"
  onLoadAnyway: () => void
}) {
  const t = useTranslate()
  const external = useOpenInDefaultApp(itemId, kind)
  return (
    <div data-testid="library-viewer-large" className="flex flex-col items-start gap-3 p-6 text-sm">
      <p className="text-muted-foreground">
        {t("This file is {size}, over the viewer's {limit} limit. Loading it may be slow.")
          .replace("{size}", formatMegabytes(size))
          .replace("{limit}", formatMegabytes(limitBytes))}
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="library-viewer-load-anyway"
          onClick={onLoadAnyway}
        >
          {t("Load anyway")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={external.open}
        >
          <ExternalLink className="size-3.5" />
          {t("Open in default app")}
        </Button>
      </div>
      {external.error ? (
        <p className="cursor-text select-text text-destructive text-xs">{external.error}</p>
      ) : null}
    </div>
  )
}

/** A file type the viewer cannot show: a message and "Open in default app". */
function OtherFile({ itemId, kind }: { itemId: string; kind: "zotero" | "folder" }) {
  const t = useTranslate()
  const external = useOpenInDefaultApp(itemId, kind)
  return (
    <div data-testid="library-viewer-other" className="flex flex-col items-start gap-3 p-6 text-sm">
      <p className="text-muted-foreground">{t("PI Lab can't show this file type.")}</p>
      <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={external.open}>
        <ExternalLink className="size-3.5" />
        {t("Open in default app")}
      </Button>
      {external.error ? (
        <p className="cursor-text select-text text-destructive text-xs">{external.error}</p>
      ) : null}
    </div>
  )
}

/** A byte count as megabytes, e.g. "34.2 MB". */
function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** A web page in a plain iframe, with its address and "Open in browser". */
function UrlTab({ url, title }: { url: string; title: string }) {
  const t = useTranslate()
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-border border-b px-3 py-1.5 text-xs">
        <span className="min-w-0 flex-1 cursor-text select-text truncate text-muted-foreground">
          {url}
        </span>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="size-3.5" />
          {t("Open in browser")}
        </a>
      </div>
      <iframe
        data-testid="library-viewer-url"
        title={title}
        src={url}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        className="min-h-0 flex-1 bg-white"
      />
    </div>
  )
}

function ViewerMessage({ text, error }: { text: string; error?: boolean }) {
  return (
    <p
      className={cn(
        "cursor-text select-text p-6 text-xs",
        error ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {text}
    </p>
  )
}
