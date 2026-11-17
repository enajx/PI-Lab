import { parentPort } from "node:worker_threads"
import { TRPCError } from "@trpc/server"
import { type PreviewWorkerJob, type PreviewWorkerReply, runPreviewJob } from "./previewWorker"

/**
 * The Analysis preview worker thread (built to `out/main/analysisPreviewWorker.js`).
 * It answers each `{ id, job }` with the preview or chart, or the error's tRPC code
 * and message, so the router throws the same error as in process.
 */

const port = parentPort
if (!port) throw new Error("The Analysis preview worker must run in a worker thread")

port.on("message", ({ id, job }: { id: number; job: PreviewWorkerJob }) => {
  runPreviewJob(job).then(
    (result) => {
      const reply: PreviewWorkerReply = { id, ok: true, result }
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
