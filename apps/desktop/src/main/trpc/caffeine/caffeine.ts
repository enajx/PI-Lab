import { z } from "zod"
import { writeCaffeineSettings } from "../settings"
import { publicProcedure, router } from "../trpc"

const modeInput = z.object({ mode: z.enum(["off", "on", "auto"]) })
const scopeInput = z.object({
  scope: z.enum(["system-only", "system-plus-display"]),
})

/**
 * Persisted caffeine controls. Status is deliberately a read-only query: routine
 * header polling must never become Auto activity.
 */
export const caffeineRouter = router({
  status: publicProcedure.query(({ ctx }) => ctx.caffeine.status()),

  setMode: publicProcedure.input(modeInput).mutation(({ ctx, input }) => {
    const settings = writeCaffeineSettings(ctx.db, { mode: input.mode })
    return ctx.caffeine.configure(settings)
  }),

  setScope: publicProcedure.input(scopeInput).mutation(({ ctx, input }) => {
    const settings = writeCaffeineSettings(ctx.db, { scope: input.scope })
    return ctx.caffeine.configure(settings)
  }),
})
