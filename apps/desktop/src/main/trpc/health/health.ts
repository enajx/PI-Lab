import { observable } from "@trpc/server/observable"
import { z } from "zod"
import { getDbStatus } from "../../db/db"
import { publicProcedure, router } from "../trpc"

/**
 * Liveness + DB-version probe. This is the contract the renderer's `app-ready`
 * marker and the smoke harness assert against — proving the
 * whole path (renderer → IPC → main → SQLite) is wired before any feature
 * lands.
 */
export const healthRouter = router({
  /** Round-trips through IPC; echoes back so the renderer can confirm liveness. */
  ping: publicProcedure.input(z.object({ message: z.string() }).optional()).query(({ input }) => ({
    ok: true as const,
    echo: input?.message ?? "pong",
    at: Date.now(),
  })),

  /**
   * Applied-migration count + newest tag from this boot. The smoke harness
   * asserts `appliedCount` is at the latest version; the renderer shows the tag.
   */
  dbVersion: publicProcedure.query(() => {
    const { appliedCount, latestTag, recovered } = getDbStatus()
    return { appliedCount, latestTag, recovered }
  }),

  /**
   * Subscriptions over `trpc-electron` MUST return an `observable`, never an
   * async generator — the IPC link throws on generators. This
   * stub documents the shape; it emits once and completes. Real subscriptions
   * (terminal bytes, port changes) land in later phases following this pattern.
   */
  heartbeat: publicProcedure.subscription(() =>
    observable<{ at: number }>((emit) => {
      emit.next({ at: Date.now() })
      emit.complete()
      return () => {}
    }),
  ),
})
