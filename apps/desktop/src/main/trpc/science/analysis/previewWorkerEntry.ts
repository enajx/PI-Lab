import { parentPort } from "node:worker_threads"
import { TRPCError } from "@trpc/server"
import { previewDataFile } from "./discover"
import type { AnalysisPreviewRequest, PreviewWorkerReply } from "./previewWorker"

/**
 * The Analysis preview worker thread (built to `out/main/analysisPreviewWorker.js`).
 * It answers each `{ id, request }` with the preview or the error's tRPC code
 * and message, so the router throws the same error as in process.
 */

const port = parentPort
if (!port) throw new Error("The Analysis preview worker must run in a worker thread")

port.on("message", ({ id, request }: { id: number; request: AnalysisPreviewRequest }) => {
  previewDataFile(request.absPath, request.relPath, request).then(
    (preview) => {
      const reply: PreviewWorkerReply = { id, ok: true, preview }
      port.postMessage(reply)
    },
    (error: unknown) => {
      const reply: PreviewWorkerReply = {
        id,
        ok: false,
        code: error instanceof TRPCError ? error.code : "INTERNAL_SERVER_ERROR",
        message: error instanceof Error ? error.message : String(error),
      }
      port.postMessage(reply)
    },
  )
})
