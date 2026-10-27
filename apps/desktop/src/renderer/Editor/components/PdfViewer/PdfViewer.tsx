import { ChevronLeft, ChevronRight, RotateCw } from "lucide-react"
import { getDocument, type PDFDocumentProxy, PDFWorker } from "pdfjs-dist/legacy/build/pdf.mjs"
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"
import { EventBus, PDFLinkService, PDFViewer } from "pdfjs-dist/legacy/web/pdf_viewer.mjs"
import { useEffect, useRef, useState } from "react"
import type { PiLabTrpcClient } from "../../../trpc/client"
import "pdfjs-dist/web/pdf_viewer.css"
import "./pdfViewer.css"

export interface PdfBuildState {
  state: "building" | "complete" | "failed"
  failedOutputs?: Record<string, { mtimeMs: number; size: number }>
}

/** Reject stalled worker startup as well as document parsing failures. */
function loadWithTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("PDF loading timed out")), 15_000)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export interface PdfLocation {
  relPath: string
  page: number
  x: number
  y: number
}
export interface SourceLocation {
  relPath: string
  line: number
  column: number
}
interface Runtime {
  viewer: PDFViewer
  document: PDFDocumentProxy
  container: HTMLDivElement
  destroy: () => void
}
interface Position {
  page: number
  scale: string
  offset: number
  left: number
}

/** PDF.js owns the page DOM; React owns the toolbar and the document lifecycle. */
export function PdfViewer({
  client,
  workspaceId,
  relPath,
  location,
  onSource,
  build,
}: {
  client: PiLabTrpcClient
  workspaceId: string
  relPath: string
  location: PdfLocation | null
  onSource: (location: SourceLocation) => void
  build: PdfBuildState | null
}) {
  const host = useRef<HTMLDivElement>(null)
  const runtime = useRef<Runtime | null>(null)
  const navigateSource = useRef(onSource)
  navigateSource.current = onSource
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(0)
  const [scale, setScale] = useState("page-width")
  const [message, setMessage] = useState("Loading PDF…")
  const [error, setError] = useState<string | null>(null)
  const refreshAction = useRef<() => void>(() => undefined)
  const [ready, setReady] = useState<Runtime | null>(null)
  const consumedLocation = useRef<PdfLocation | null>(null)
  const buildRef = useRef(build)
  buildRef.current = build

  useEffect(() => {
    let live = true
    let busy = false
    let baseline = ""
    let pendingDispose: (() => void) | null = null
    let staged: Runtime | null = null
    const root = host.current
    if (!root) return

    const buildIsRunning = (): boolean => buildRef.current?.state === "building"

    /** Load into a second surface so the last rendered PDF stays visible during replacement. */
    const refresh = async (): Promise<void> => {
      if (!live || busy || root.clientWidth === 0 || buildIsRunning()) return
      busy = true
      try {
        const stat = await client.files.stat.query({ workspaceId, relPath })
        if (!live) return
        if (!stat.exists) throw new Error("PDF is missing. Waiting for it to be written again.")
        const blocked = buildRef.current?.failedOutputs?.[relPath]
        if (blocked && blocked.mtimeMs === stat.mtimeMs && blocked.size === stat.size) {
          setMessage("Last LaTeX build failed; showing previous PDF")
          return
        }
        const fingerprint = `${stat.mtimeMs}:${stat.size}`
        if (fingerprint === baseline) {
          setMessage("PDF up to date")
          return
        }
        setMessage(runtime.current ? "Refreshing PDF…" : "Loading PDF…")
        const snapshot = await client.pdf.read.query({ workspaceId, relPath })
        if (!live) return
        const assets = new URL("pdfjs/", document.baseURI).href
        const port = new Worker(workerUrl, { type: "module" })
        // PDF.js 6 declarations infer port as null, although its constructor accepts Worker.
        const worker = new PDFWorker({ port } as unknown as ConstructorParameters<
          typeof PDFWorker
        >[0])
        const task = getDocument({
          worker,
          data: new Uint8Array(snapshot.data),
          cMapUrl: `${assets}cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${assets}standard_fonts/`,
          wasmUrl: `${assets}wasm/`,
          iccUrl: `${assets}iccs/`,
        })
        let disposed = false
        const dispose = (): void => {
          if (disposed) return
          disposed = true
          const stop = (): void => {
            worker.destroy()
            port.terminate()
          }
          // PDF.js can wait forever for a worker that never completed setup.
          const timeout = window.setTimeout(stop, 1_000)
          void task
            .destroy()
            .finally(() => {
              window.clearTimeout(timeout)
              stop()
            })
            .catch(console.error)
        }
        pendingDispose = dispose
        const pdf = await loadWithTimeout(task.promise)
        if (!live) {
          dispose()
          return
        }
        const previous = runtime.current
        const oldViewer = previous?.viewer
        const oldPage = oldViewer?.currentPageNumber ?? 1
        const position: Position = {
          page: Math.min(oldPage, pdf.numPages),
          scale: oldViewer?.currentScaleValue ?? "page-width",
          offset: previous
            ? previous.container.scrollTop - previous.viewer.getPageView(oldPage - 1).div.offsetTop
            : 0,
          left: previous?.container.scrollLeft ?? 0,
        }
        const container = document.createElement("div")
        container.className = "pi-pdf-pages absolute inset-0 overflow-auto"
        container.style.visibility = "hidden"
        const content = document.createElement("div")
        content.className = "pdfViewer"
        container.append(content)
        root.append(container)
        const events = new EventBus()
        const links = new PDFLinkService({
          eventBus: events,
          externalLinkTarget: 2,
          externalLinkRel: "noopener noreferrer",
        })
        const abort = new AbortController()
        const options: ConstructorParameters<typeof PDFViewer>[0] & { abortSignal: AbortSignal } = {
          abortSignal: abort.signal,
          container,
          viewer: content,
          eventBus: events,
          linkService: links,
          annotationMode: 1,
        }
        const viewer = new PDFViewer(options)
        links.setViewer(viewer)
        links.setDocument(pdf)
        const next: Runtime = {
          viewer,
          document: pdf,
          container,
          destroy: () => {
            abort.abort()
            viewer.setDocument(null)
            links.setDocument(null)
            container.remove()
            dispose()
          },
        }
        staged = next
        container.addEventListener("dblclick", (event) => {
          const element =
            event.target instanceof Element ? event.target.closest<HTMLElement>(".page") : null
          if (!element || runtime.current !== next) return
          const index = Number(element.dataset.pageNumber) - 1
          const pageView = viewer.getPageView(index)
          const bounds = element.getBoundingClientRect()
          const [x, y] = pageView.viewport.convertToPdfPoint(
            event.clientX - bounds.left,
            event.clientY - bounds.top,
          )
          const pageTop = pageView.pdfPage?.view[3]
          if (pageTop === undefined) return
          void client.pdf.reverseSync
            .mutate({ workspaceId, relPath, page: index + 1, x, y: pageTop - y })
            .then((source) => {
              if (live && runtime.current === next) {
                setError(null)
                navigateSource.current(source)
              }
            })
            .catch((cause: unknown) => {
              if (live) setError(String(cause))
            })
        })
        // PDF.js emits pagesinit once page dimensions and navigation are available.
        let cancelReady: (() => void) | null = null
        const rendered = new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(
            () => reject(new Error("PDF rendering timed out")),
            15_000,
          )
          const clear = (): void => window.clearTimeout(timeout)
          cancelReady = () => {
            clear()
            reject(new Error("PDF loading cancelled"))
          }
          events.on("pagesinit", () => {
            viewer.currentScaleValue = position.scale
            viewer.currentPageNumber = position.page
            container.scrollTop =
              viewer.getPageView(position.page - 1).div.offsetTop + position.offset
            container.scrollLeft = position.left
          })
          events.on("pagerendered", ({ error }: { error?: unknown }) => {
            clear()
            if (error) reject(error)
            else resolve()
          })
        })
        const destroy = next.destroy
        next.destroy = () => {
          cancelReady?.()
          cancelReady = null
          destroy()
        }
        events.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
          if (runtime.current === next) setPage(pageNumber)
        })
        events.on("scalechanging", () => {
          if (runtime.current === next) setScale(viewer.currentScaleValue)
        })
        viewer.setDocument(pdf)
        await rendered
        cancelReady = null
        if (!live) return
        // A new save may have started compilation while these pages were rendering.
        const failed = buildRef.current?.failedOutputs?.[relPath]
        if (
          buildIsRunning() ||
          (failed &&
            failed.mtimeMs === snapshot.baseline.mtimeMs &&
            failed.size === snapshot.baseline.size)
        ) {
          next.destroy()
          staged = null
          return
        }
        container.style.visibility = "visible"
        runtime.current = next
        staged = null
        previous?.destroy()
        baseline = `${snapshot.baseline.mtimeMs}:${snapshot.baseline.size}`
        setPages(pdf.numPages)
        setPage(viewer.currentPageNumber)
        setScale(viewer.currentScaleValue)
        setMessage("PDF up to date")
        setError(null)
        setReady(next)
      } catch (cause) {
        staged?.destroy()
        pendingDispose?.()
        staged = null
        if (live) setError(`Could not load PDF: ${String(cause)}`)
      } finally {
        pendingDispose = null
        busy = false
      }
    }
    refreshAction.current = () => {
      baseline = ""
      void refresh()
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 750)
    return () => {
      live = false
      window.clearInterval(timer)
      staged?.destroy()
      pendingDispose?.()
      runtime.current?.destroy()
      runtime.current = null
      refreshAction.current = () => undefined
    }
  }, [client, workspaceId, relPath])

  useEffect(() => {
    const current = ready
    if (
      !current ||
      !location ||
      location.relPath !== relPath ||
      consumedLocation.current === location
    )
      return
    let live = true
    void current.document
      .getPage(location.page)
      .then((pdfPage) => {
        if (!live || runtime.current !== current) return
        consumedLocation.current = location
        current.viewer.scrollPageIntoView({
          pageNumber: location.page,
          destArray: [
            null,
            { name: "XYZ" },
            Math.max(0, location.x - 24),
            Math.min(pdfPage.view[3] ?? 0, (pdfPage.view[3] ?? 0) - location.y + 32),
            null,
          ],
          ignoreDestinationZoom: true,
        })
      })
      .catch((cause: unknown) => {
        if (live) setError(String(cause))
      })
    return () => {
      live = false
    }
  }, [location, relPath, ready])

  return (
    <div data-testid="pdf-viewer" className="flex min-h-0 flex-1 flex-col bg-background">
      <div
        role="toolbar"
        aria-label="PDF controls"
        className="flex h-10 shrink-0 items-center gap-2 border-border border-b px-3 text-xs"
      >
        <button
          type="button"
          aria-label="Previous PDF page"
          disabled={page <= 1}
          onClick={() => {
            if (runtime.current) runtime.current.viewer.currentPageNumber = page - 1
          }}
          className="rounded p-1 hover:bg-accent disabled:opacity-30"
        >
          <ChevronLeft className="size-4" />
        </button>
        <input
          data-testid="pdf-page-number"
          aria-label="PDF page"
          type="number"
          min={1}
          max={pages || 1}
          value={page}
          className="w-12 rounded border border-border bg-background px-1 py-0.5 text-center"
          onChange={(event) => {
            const value = Number(event.target.value)
            if (runtime.current && value >= 1 && value <= pages)
              runtime.current.viewer.currentPageNumber = value
          }}
        />
        <span className="text-muted-foreground">/ {pages || "…"}</span>
        <button
          type="button"
          aria-label="Next PDF page"
          disabled={page >= pages}
          onClick={() => {
            if (runtime.current) runtime.current.viewer.currentPageNumber = page + 1
          }}
          className="rounded p-1 hover:bg-accent disabled:opacity-30"
        >
          <ChevronRight className="size-4" />
        </button>
        <span className="mx-1 h-4 border-border border-l" />
        <select
          data-testid="pdf-zoom"
          aria-label="PDF zoom"
          value={scale}
          onChange={(event) => {
            if (runtime.current) runtime.current.viewer.currentScaleValue = event.target.value
          }}
          className="rounded border border-border bg-background px-2 py-1"
        >
          <option value="page-width">Fit width</option>
          <option value="page-fit">Fit page</option>
          {[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((value) => (
            <option key={value} value={String(value)}>
              {value * 100}%
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label="Reload PDF"
          title="Reload PDF"
          onClick={() => refreshAction.current()}
          className="rounded p-1 hover:bg-accent"
        >
          <RotateCw className="size-3.5" />
        </button>
        <span className="ml-auto truncate text-muted-foreground">
          Double-click to show LaTeX source
        </span>
      </div>
      {error ? (
        <p
          role="alert"
          className="shrink-0 select-text border-border border-b px-3 py-2 text-destructive text-xs"
        >
          {error}
        </p>
      ) : null}
      <div ref={host} className="relative min-h-0 flex-1 overflow-hidden bg-muted/40" />
      <div
        data-testid="pdf-status"
        role="status"
        className="shrink-0 border-border border-t px-3 py-1 text-muted-foreground text-xs"
      >
        {message}
      </div>
    </div>
  )
}
