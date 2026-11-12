import { z } from "zod"
import type { DictationService } from "../../dictation/service"
import type { AppContext } from "../context"
import { publicProcedure, router } from "../trpc"

const keyInput = z.object({ key: z.string().min(1) })
const outputAction = z.enum(["insert", "review", "insert-copy", "copy"])
const waveformStyle = z.enum(["dots", "ascii-art", "lines"])

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
