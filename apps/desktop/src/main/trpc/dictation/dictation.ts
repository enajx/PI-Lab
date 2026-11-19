import { z } from "zod"
import type { DictationService } from "../../dictation/service"
import type { AppContext } from "../context"
import { publicProcedure, router } from "../trpc"

const keyInput = z.object({ key: z.string().min(1) })
const outputAction = z.enum(["insert", "review", "insert-copy", "copy"])
const waveformStyle = z.enum(["dots", "ascii-art", "lines"])
/** A transcription and the model that made it. */
const transcription = z.strictObject({ text: z.string(), modelKey: z.string() })
const streamId = z.string().min(1)
/** One chunk of 16 kHz mono 16-bit PCM; `seq` counts from 0. */
const streamChunk = z.object({
  streamId,
  seq: z.number().int().min(0),
  pcmBase64: z.string(),
})

function service(ctx: AppContext): DictationService {
  if (!ctx.dictation) throw new Error("Dictation is unavailable in this app context")
  return ctx.dictation
}

/** Local dictation: model downloads, the whisper.cpp engine, settings and history. */
export const dictationRouter = router({
  status: publicProcedure.query(({ ctx }) => service(ctx).status()),
  downloadModel: publicProcedure
    .input(keyInput)
    .mutation(({ ctx, input }) => service(ctx).downloadModel(input.key)),
  cancelDownload: publicProcedure.mutation(({ ctx }) => service(ctx).cancelDownload()),
  deleteModel: publicProcedure
    .input(keyInput)
    .mutation(({ ctx, input }) => service(ctx).deleteModel(input.key)),
  selectModel: publicProcedure
    .input(keyInput)
    .mutation(({ ctx, input }) => service(ctx).selectModel(input.key)),
  setOutputAction: publicProcedure
    .input(z.object({ action: outputAction }))
    .mutation(({ ctx, input }) => service(ctx).setOutputAction(input.action)),
  setWaveformStyle: publicProcedure
    .input(z.object({ style: waveformStyle }))
    .mutation(({ ctx, input }) => service(ctx).setWaveformStyle(input.style)),
  requestMicrophone: publicProcedure.mutation(async ({ ctx }) => ({
    granted: await service(ctx).requestMicrophone(),
  })),
  openMicrophoneSettings: publicProcedure.mutation(({ ctx }) =>
    service(ctx).openMicrophoneSettings(),
  ),
  prepare: publicProcedure.mutation(({ ctx }) => service(ctx).prepare()),
  transcribe: publicProcedure
    .input(z.object({ wavBase64: z.string().min(1) }))
    .mutation(({ ctx, input }) => service(ctx).transcribe(input.wavBase64)),
  /** PCM sent while the user speaks; finish transcribes it. */
  stream: router({
    start: publicProcedure
      .output(z.strictObject({ streamId }))
      .mutation(({ ctx }) => service(ctx).startStream()),
    append: publicProcedure
      .input(streamChunk)
      .output(z.void())
      .mutation(({ ctx, input }) =>
        service(ctx).appendStream(
          input.streamId,
          input.seq,
          Buffer.from(input.pcmBase64, "base64"),
        ),
      ),
    finish: publicProcedure
      .input(streamChunk)
      .output(transcription)
      .mutation(({ ctx, input }) =>
        service(ctx).finishStream(
          input.streamId,
          input.seq,
          Buffer.from(input.pcmBase64, "base64"),
        ),
      ),
    cancel: publicProcedure
      .input(z.object({ streamId }))
      .output(z.void())
      .mutation(({ ctx, input }) => service(ctx).cancelStream(input.streamId)),
  }),
  history: router({
    list: publicProcedure
      .input(z.object({ query: z.string().nullable() }))
      .query(({ ctx, input }) => service(ctx).listHistory(input.query)),
    delete: publicProcedure
      .input(z.object({ id: z.string().min(1) }))
      .mutation(({ ctx, input }) => service(ctx).deleteHistory(input.id)),
    add: publicProcedure
      .input(z.object({ text: z.string().min(1), modelKey: z.string().min(1) }))
      .mutation(({ ctx, input }) => service(ctx).addHistory(input.text, input.modelKey)),
    clear: publicProcedure.mutation(({ ctx }) => service(ctx).clearHistory()),
  }),
})
