import { getDocument, type PDFDocumentProxy, PDFWorker } from "pdfjs-dist/legacy/build/pdf.mjs"
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"
import { EventBus, PDFLinkService, PDFViewer } from "pdfjs-dist/legacy/web/pdf_viewer.mjs"
import { useEffect, useRef, useState } from "react"
import type { PiLabTrpcClient } from "../../../trpc/client"
import "pdfjs-dist/web/pdf_viewer.css"
import "./pdfViewer.css"
import { anchorScroll, pdfStatusText, wheelZoom } from "./pdfZoom"

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

/** PDF.js scale presets that depend on the viewer's size. */
const RELATIVE_SCALES = new Set(["page-width", "page-fit", "auto"])

/** PDF.js owns the page DOM; React owns the document lifecycle and wheel zoom. */
export function PdfViewer({
  client,
  workspaceId,
  relPath,
  location,
  onSource,
  build,
  onMessage,
}: {
  client: PiLabTrpcClient
  workspaceId: string
  relPath: string
  location: PdfLocation | null
  onSource: (location: SourceLocation) => void
  build: PdfBuildState | null
  /** Refresh state and current page, e.g. "Page 2 / 5", shown by the central panel's status bar. */
  onMessage: (message: string) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const runtime = useRef<Runtime | null>(null)
  const navigateSource = useRef(onSource)
  navigateSource.current = onSource
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(0)
  /** Transient refresh state; null once the PDF is loaded and current. */
  const [message, setMessage] = useState<string | null>("Loading PDF…")
  const reportMessage = useRef(onMessage)
  reportMessage.current = onMessage
  useEffect(
    () => reportMessage.current(pdfStatusText(message, page, pages)),
    [message, page, pages],
  )
  const [error, setError] = useState<string | null>(null)
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
          setMessage(null)
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
        setMessage(null)
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
    void refresh()
    const timer = window.setInterval(() => void refresh(), 750)
    return () => {
      live = false
      window.clearInterval(timer)
      staged?.destroy()
      pendingDispose?.()
      runtime.current?.destroy()
      runtime.current = null
    }
  }, [client, workspaceId, relPath])

  // Fit width / fit page are computed from the viewer's size. A split lays out after the
  // PDF loads and can be resized later, so re-apply a relative scale when the size changes.
  useEffect(() => {
    const root = host.current
    if (!root) return
    const observer = new ResizeObserver(() => {
      const viewer = runtime.current?.viewer
      if (!viewer || root.clientWidth === 0) return
      const value = viewer.currentScaleValue
      if (RELATIVE_SCALES.has(value)) viewer.currentScaleValue = value
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  // A trackpad pinch (ctrl + wheel) or Shift + wheel zooms instead of scrolling. The
  // listener is not passive so preventDefault also stops Electron zooming the window.
  // The page point under the pointer stays under it: PDF.js lays out the pages again
  // synchronously when the scale is set, so the scroll is corrected right after.
  useEffect(() => {
    const root = host.current
    if (!root) return
    const zoom = (event: WheelEvent): void => {
      const current = runtime.current
      if (!current) return
      const { viewer, container } = current
      const next = wheelZoom(viewer.currentScale, event)
      if (next === null) return
      event.preventDefault()
      if (next === viewer.currentScale) return
      // Anchor on the page under the pointer, or the current page over a gap.
      const hovered = event.target instanceof Element ? event.target.closest(".page") : null
      const page =
        hovered && container.contains(hovered)
          ? hovered
          : viewer.getPageView(viewer.currentPageNumber - 1).div
      const pointer = { x: event.clientX, y: event.clientY }
      const before = page.getBoundingClientRect()
      viewer.currentScale = next
      const shift = anchorScroll(pointer, before, page.getBoundingClientRect())
      container.scrollLeft += shift.left
      container.scrollTop += shift.top
    }
    root.addEventListener("wheel", zoom, { passive: false })
    return () => root.removeEventListener("wheel", zoom)
  }, [])

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
      {error ? (
        <p
          role="alert"
          className="shrink-0 select-text border-border border-b px-3 py-2 text-destructive text-xs"
        >
          {error}
        </p>
      ) : null}
      <div ref={host} className="relative min-h-0 flex-1 overflow-hidden bg-muted/40" />
    </div>
  )
}
