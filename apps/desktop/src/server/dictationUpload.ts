import type { IncomingMessage, ServerResponse } from "node:http"
import type { AppContext } from "../main/trpc/context"
import { dictationAudioFormat, timedTranscription } from "../main/trpc/dictation/dictation"

/** `POST /dictation/transcribe?format=wav|m4a|ogg`: the body is the recording's bytes. */
export const DICTATION_UPLOAD_PATH = "/dictation/transcribe"
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/**
 * Transcribe a recording sent as a plain binary body (no base64), with the
 * device token checked in http.ts before this runs. The answer is the same
 * JSON as `dictation.transcribeAudio`; a failure is a 400 with the message.
 */
export async function handleDictationUpload(
  ctx: AppContext,
  url: URL,
  request: IncomingMessage,
  out: ServerResponse,
): Promise<void> {
  out.once("finish", () => request.resume())
  const format = dictationAudioFormat.safeParse(url.searchParams.get("format"))
  if (!format.success) return reply(out, 400, "format must be wav, m4a or ogg")
  const dictation = ctx.dictation
  if (!dictation) return reply(out, 404, "Dictation is unavailable in this app context")
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += (chunk as Buffer).length
    if (bytes > MAX_UPLOAD_BYTES) return reply(out, 413, "The recording is too long to transcribe")
    chunks.push(chunk as Buffer)
  }
  const result = await dictation.transcribeAudio(Buffer.concat(chunks), format.data).then(
    (value) => timedTranscription.parse(value),
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  )
  if (result instanceof Error) return reply(out, 400, result.message)
  out.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result))
}

function reply(out: ServerResponse, status: number, message: string): void {
  out.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(message)
}
