import type { DaemonClient, DataEvent, ExitEvent } from "@pi-lab/pty-daemon"
import { observable } from "@trpc/server/observable"
import { z } from "zod"
import { publicProcedure, router } from "../trpc"

/**
 * Terminal router — the renderer's contract to the PTY daemon.
 *
 * Every procedure is a thin bridge to the supervisor's {@link DaemonClient}
 * obtained from context; all real PTY ownership (spawn, scrollback, reattach)
 * lives in `@pi-lab/pty-daemon` and is reused, not reimplemented. Keeping these
 * one-liners over a fetched client makes the router `createCaller`-testable
 * without an Electron window.
 */

const spawnInput = z.object({
  cwd: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
})

const sessionIdInput = z.object({ sessionId: z.string() })

const writeInput = z.object({ sessionId: z.string(), data: z.string() })

const resizeInput = z.object({
  sessionId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
})

/** A login shell is the sensible default when the UI doesn't name a command. */
const DEFAULT_SHELL = process.env.SHELL ?? "/bin/bash"

// Multiple observers of one session share a physical daemon attachment.
const sessionObservers = new WeakMap<DaemonClient, Map<string, Set<() => void>>>()

/** What `onData` streams to the renderer: incremental chunks, then a terminal exit. */
export type TerminalEvent =
  | { type: "data"; chunk: string }
  | { type: "exit"; exitCode: number | null; signal: number | null }

export const terminalRouter = router({
  /**
   * Spawn a PTY. With no explicit `command` we start the user's login shell;
   * `args` extend it (the agent-launch builder supplies them in a later phase).
   */
  spawn: publicProcedure.input(spawnInput).mutation(async ({ ctx, input }) => {
    const client = await ctx.getDaemonClient()
    const session = await client.spawn({
      command: input.command ?? DEFAULT_SHELL,
      args: input.args,
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
    })
    return { sessionId: session.id }
  }),

  /** Feed bytes to a session's stdin. */
  write: publicProcedure.input(writeInput).mutation(async ({ ctx, input }) => {
    const client = await ctx.getDaemonClient()
    ctx.activityMonitor.userInput(input.sessionId, input.data)
    await client.write(input.sessionId, input.data)
    ctx.caffeine.markTerminalActivity()
    return { ok: true as const }
  }),

  /** Resize a session's PTY. */
  resize: publicProcedure.input(resizeInput).mutation(async ({ ctx, input }) => {
    const client = await ctx.getDaemonClient()
    await client.resize(input.sessionId, input.cols, input.rows)
    ctx.activityMonitor.resize(input.sessionId, input.cols, input.rows)
    return { ok: true as const }
  }),

  /** Terminate a session (terminal hangup by default on Unix). */
  kill: publicProcedure.input(sessionIdInput).mutation(async ({ ctx, input }) => {
    const client = await ctx.getDaemonClient()
    await client.kill(input.sessionId)
    return { ok: true as const }
  }),

  /** Live sessions known to the daemon. */
  list: publicProcedure.query(async ({ ctx }) => {
    const client = await ctx.getDaemonClient()
    return client.list()
  }),

  /**
   * Stream one session's output. MUST be an `observable`, never an async
   * generator — the `trpc-electron` IPC link throws on generators (AGENTS.md
   * the IPC link throws on generators).
   *
   * Bridging the daemon's contract: on subscribe we `attach` (which snapshots
   * scrollback and begins live delivery atomically on the daemon side), then
   * forward (a) the replayed scrollback as a single leading `data` event so a
   * late subscriber sees prior output, and (b) every subsequent live `data`
   * event, ending with the `exit` event after which the observable completes.
   * Session-scoped client events keep us from cross-talking between sessions.
   */
  onData: publicProcedure.input(sessionIdInput).subscription(({ ctx, input }) =>
    observable<TerminalEvent>((emit) => {
      const { sessionId } = input
      let attaching = true
      const deliver = (event: DataEvent | ExitEvent) => {
        if (event.kind === "data") {
          ctx.caffeine.markTerminalActivity()
          emit.next({ type: "data", chunk: event.chunk })
        } else {
          emit.next({ type: "exit", exitCode: event.exitCode, signal: event.signal })
          emit.complete()
        }
      }
      const onEvent = (event: DataEvent | ExitEvent) => {
        // Anything before the attach reply is already included in its snapshot.
        if (!attaching) deliver(event)
      }

      let cleanup = () => {}
      let cancelled = false

      void (async () => {
        try {
          const client = await ctx.getDaemonClient()
          if (cancelled) return
          const eventName = `session:${sessionId}`
          client.on(eventName, onEvent)
          let observers = sessionObservers.get(client)
          if (!observers) {
            observers = new Map<string, Set<() => void>>()
            sessionObservers.set(client, observers)
            const watched = observers
            client.once("close", () => {
              sessionObservers.delete(client)
              for (const listeners of watched.values()) {
                for (const notify of listeners) notify()
              }
              watched.clear()
            })
          }
          const listeners = observers.get(sessionId) ?? new Set<() => void>()
          const onClose = () => emit.error(new Error("daemon connection closed"))
          listeners.add(onClose)
          observers.set(sessionId, listeners)
          cleanup = () => {
            client.off(eventName, onEvent)
            listeners.delete(onClose)
            if (listeners.size === 0) {
              observers.delete(sessionId)
              void client.detach(sessionId).catch(() => {})
            }
            cleanup = () => {}
          }
          await client.attach(sessionId, ({ scrollback }) => {
            if (cancelled) return
            if (scrollback.length > 0) emit.next({ type: "data", chunk: scrollback })
            attaching = false
          })
        } catch (error) {
          cleanup()
          if (!cancelled) emit.error(error instanceof Error ? error : new Error(String(error)))
        }
      })()

      return () => {
        cancelled = true
        cleanup()
      }
    }),
  ),
})
