import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { TRPCError } from "@trpc/server"
import { type PreviewOptions, previewDataFile } from "./discover"
import type { DataFilePreview } from "./previewShapes"

/**
 * Analysis previews run off Electron's main thread: the format readers
 * (the unpickler, h5wasm, hyparquet) can spend seconds of CPU on a large file,
 * and on the main thread that would stall every tRPC call and the window. The
 * app runs them in one long-lived worker thread; router tests run them in
 * process ({@link inProcessAnalysisPreview}). If the worker dies (e.g. out of
 * memory on a huge pickle), its pending previews fail with that reason and the
 * next preview starts a new worker.
 */

/** One preview request: the jailed path, the shown path, and the options. */
export interface AnalysisPreviewRequest extends PreviewOptions {
  absPath: string
  relPath: string
}

export interface AnalysisPreviewPort {
  preview(request: AnalysisPreviewRequest): Promise<DataFilePreview>
  dispose(): void
}

/** Previews in the calling thread (router tests). */
export const inProcessAnalysisPreview: AnalysisPreviewPort = {
  preview: (request) => previewDataFile(request.absPath, request.relPath, request),
  dispose: () => undefined,
}

/** A worker's answer to one request. */
export type PreviewWorkerReply =
  | { id: number; ok: true; preview: DataFilePreview }
  | { id: number; ok: false; code: TRPCError["code"]; message: string }

/** The built worker script, next to the main bundle (`out/main`). */
const WORKER_FILE = "analysisPreviewWorker.js"
/** Heap limit of the worker; past it only the worker dies, not the app. */
const WORKER_HEAP_MB = 4096
/**
 * Longest one preview may take (a 200 MB pickle of Python objects takes about
 * 5 s). Past it the worker is stopped, so a hostile or corrupt file cannot hold
 * up every later preview; the next preview starts a new worker.
 */
const PREVIEW_TIMEOUT_MS = 120_000

interface Pending {
  resolve: (preview: DataFilePreview) => void
  reject: (error: Error) => void
}

/** Previews in a worker thread (the app). */
export class WorkerAnalysisPreview implements AnalysisPreviewPort {
  private worker: Worker | null = null
  private nextId = 0
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly mainDir: string) {}

  preview(request: AnalysisPreviewRequest): Promise<DataFilePreview> {
    const worker = this.ensureWorker()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stopWorker(
          worker,
          `reading ${request.relPath} took over ${PREVIEW_TIMEOUT_MS / 1000} s`,
        )
      }, PREVIEW_TIMEOUT_MS)
      const done = () => clearTimeout(timer)
      this.pending.set(id, {
        resolve: (preview) => {
          done()
          resolve(preview)
        },
        reject: (error) => {
          done()
          reject(error)
        },
      })
      worker.postMessage({ id, request })
    })
  }

  dispose(): void {
    const worker = this.worker
    this.worker = null
    this.failAll(new Error("Analysis previews stopped"))
    void worker?.terminate()
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(join(this.mainDir, WORKER_FILE), {
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    })
    worker.on("message", (reply: PreviewWorkerReply) => {
      const pending = this.pending.get(reply.id)
      if (!pending) return
      this.pending.delete(reply.id)
      if (reply.ok) pending.resolve(reply.preview)
      else pending.reject(new TRPCError({ code: reply.code, message: reply.message }))
    })
    worker.on("error", (error) => this.stopWorker(worker, error.message))
    worker.on("exit", (code) => this.stopWorker(worker, `the reader exited with code ${code}`))
    worker.unref()
    this.worker = worker
    return worker
  }

  /** Stop `worker` (if it is still the current one) and fail its pending previews. */
  private stopWorker(worker: Worker, reason: string): void {
    if (this.worker !== worker) return
    this.worker = null
    void worker.terminate()
    this.failAll(
      new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `The preview stopped: ${reason}` }),
    )
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}
