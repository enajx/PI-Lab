import type {
  AttachResult,
  DaemonClient,
  DataEvent,
  ExitEvent,
  ResizeEvent,
  ResumePoint,
} from "@pi-lab/pty-daemon"
import { type TrackedEnvelope, tracked } from "@trpc/server"
import { observable } from "@trpc/server/observable"
import { z } from "zod"
import type { AppContext } from "../context"
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

const writeInput = z.object({
  sessionId: z.string(),
  data: z.string(),
  /** The typing client's id; absent when the server itself writes (agent launch). */
  clientId: z.string().min(1).optional(),
})

const resizeInput = z.object({
  sessionId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  /** The client asking for the size (one id per app window or device). */
  clientId: z.string().min(1),
})

/** A login shell is the sensible default when the UI doesn't name a command. */
const DEFAULT_SHELL = process.env.SHELL ?? "/bin/bash"

// Multiple observers of one session share a physical daemon attachment.
const sessionObservers = new WeakMap<DaemonClient, Map<string, Set<() => void>>>()

/** What `onData` streams to in-process callers: text chunks, then a terminal exit. */
export type TerminalEvent =
  | { type: "data"; chunk: string }
  | { type: "exit"; exitCode: number | null; signal: number | null }

/**
 * Provisional limit (set after the flood test): when more than this many bytes
 * wait in a client connection's send queue, `terminal.output` stops sending to
 * that connection and tells the client its stream is behind.
 */
export const OUTPUT_QUEUE_LIMIT_BYTES = 4 * 1024 * 1024

/**
 * A client that typed into a terminal keeps its PTY size for this long: another
 * client's focus does not take the size from it (`terminal.resize`).
 */
export const TYPING_HOLDS_SIZE_MS = 3_000

/** The last client that typed into each session, per daemon client. */
const lastTyping = new WeakMap<DaemonClient, Map<string, { clientId: string; at: number }>>()

function typingMap(client: DaemonClient): Map<string, { clientId: string; at: number }> {
  let map = lastTyping.get(client)
  if (!map) {
    map = new Map()
    lastTyping.set(client, map)
  }
  return map
}

/**
 * Where a client's screen stands: the daemon generation, the next byte its
 * emulator needs, and the screen revision. Also the tracked event id.
 */
const resumePointInput = z.object({
  generation: z.string().min(1),
  offset: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
})

const outputInput = z.object({
  sessionId: z.string(),
  /** Null asks for a screen snapshot (a new or recreated emulator). */
  resume: resumePointInput.nullable(),
})

/**
 * What `terminal.output` streams. Bytes are raw PTY output in base64; offsets
 * count raw bytes since spawn.
 * - start: first event. `replay` continues from the requested offset; for a
 *   `snapshot`, reset the emulator to `cols`x`rows`, write `screen` (which holds
 *   exactly the bytes before `offset`), then the bytes.
 * - data: the bytes starting at `offset`.
 * - resize: the PTY size changed after every byte before `offset`; the screen
 *   is now at `revision`.
 * - exit: the program ended; the stream completes.
 * - behind: this connection fell behind; the stream completes and the client
 *   subscribes again from its consumed offset.
 */
export type TerminalOutput =
  | {
      type: "start"
      generation: string
      revision: number
      cols: number
      rows: number
      mode: "replay"
      offset: number
      base64: string
    }
  | {
      type: "start"
      generation: string
      revision: number
      cols: number
      rows: number
      mode: "snapshot"
      offset: number
      screen: string
      base64: string
    }
  | { type: "data"; offset: number; base64: string }
  | { type: "resize"; offset: number; revision: number; cols: number; rows: number }
  | { type: "exit"; exitCode: number | null; signal: number | null }
  | { type: "behind" }

/** The tracked id of a terminal event: the resume point after applying it. */
function resumeId(generation: string, offset: number, revision: number): string {
  return `${generation}:${offset}:${revision}`
}

type SessionEvent = DataEvent | ResizeEvent | ExitEvent

interface SessionAttachment {
  /** Runs at the attach reply boundary, before any later event. */
  onStart: (result: AttachResult) => void
  /** Live events after the start, in daemon order. */
  onEvent: (event: SessionEvent) => void
  onError: (error: Error) => void
}

/**
 * Attach to a session on the shared daemon connection and forward its events
 * from the attach reply on. When that connection closes (the daemon dropped a
 * slow reader, or the socket broke), attach again on the supervisor's next
 * connection from the last forwarded point: the daemon answers with a replay
 * or a snapshot (its resume rules), passed to `onStart` like the first start.
 * Only a failed attach (for example, the session is gone after a daemon
 * restart) reaches `onError`. Returns the cleanup, which detaches the daemon
 * connection when the last observer of the session leaves.
 */
function attachSession(
  ctx: AppContext,
  sessionId: string,
  resume: ResumePoint | null,
  handlers: SessionAttachment,
): () => void {
  let cancelled = false
  let cleanup = () => {}
  /** The resume point after the last start or event forwarded to the handlers. */
  let point: ResumePoint | null = resume

  const attachOnce = async (from: ResumePoint | null): Promise<void> => {
    let attaching = true
    let closed = false
    const client = await ctx.getDaemonClient()
    if (cancelled) return
    const onEvent = (event: SessionEvent) => {
      // Anything before the attach reply is already included in its start.
      if (attaching || cancelled || closed) return
      if (point !== null && event.kind === "data") {
        point = { ...point, offset: event.offset + event.bytes.length }
      } else if (point !== null && event.kind === "resize") {
        point = { ...point, revision: event.revision }
      }
      handlers.onEvent(event)
    }
    const onResize = (event: ResizeEvent) => {
      if (event.sessionId === sessionId) onEvent(event)
    }
    const eventName = `session:${sessionId}`
    client.on(eventName, onEvent)
    client.on("resize", onResize)
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
    const onClose = () => {
      closed = true
      client.off(eventName, onEvent)
      client.off("resize", onResize)
      cleanup = () => {}
      if (!cancelled) run(point, true)
    }
    listeners.add(onClose)
    observers.set(sessionId, listeners)
    const watchedObservers = observers
    cleanup = () => {
      client.off(eventName, onEvent)
      client.off("resize", onResize)
      listeners.delete(onClose)
      if (listeners.size === 0) {
        watchedObservers.delete(sessionId)
        void client.detach(sessionId).catch(() => {})
      }
      cleanup = () => {}
    }
    try {
      await client.attach(sessionId, from, (result) => {
        if (cancelled) return
        point = {
          generation: result.generation,
          offset: result.start.offset + result.start.bytes.length,
          revision: result.revision,
        }
        handlers.onStart(result)
        attaching = false
      })
    } catch (error) {
      // The connection closed during the attach: onClose attaches again.
      if (closed) return
      throw error
    }
  }

  const run = (from: ResumePoint | null, afterClose: boolean): void => {
    attachOnce(from).catch((error: unknown) => {
      cleanup()
      if (cancelled) return
      const message = error instanceof Error ? error.message : String(error)
      handlers.onError(
        afterClose
          ? new Error(`daemon connection closed, and attaching again failed: ${message}`)
          : error instanceof Error
            ? error
            : new Error(message),
      )
    })
  }
  run(resume, false)

  return () => {
    cancelled = true
    cleanup()
  }
}

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
    if (input.clientId !== undefined) {
      typingMap(client).set(input.sessionId, { clientId: input.clientId, at: Date.now() })
    }
    await client.write(input.sessionId, input.data)
    ctx.caffeine.markTerminalActivity()
    return { ok: true as const }
  }),

  /**
   * Give the PTY this client's size. Refused (`applied: false`) while another
   * client typed in the session within {@link TYPING_HOLDS_SIZE_MS}; that
   * client keeps its size and this one shows the PTY with a margin.
   */
  resize: publicProcedure.input(resizeInput).mutation(async ({ ctx, input }) => {
    const client = await ctx.getDaemonClient()
    const typing = typingMap(client).get(input.sessionId)
    if (
      typing !== undefined &&
      typing.clientId !== input.clientId &&
      Date.now() - typing.at < TYPING_HOLDS_SIZE_MS
    ) {
      return { ok: true as const, applied: false }
    }
    await client.resize(input.sessionId, input.cols, input.rows)
    ctx.activityMonitor.resize(input.sessionId, input.cols, input.rows)
    return { ok: true as const, applied: true }
  }),

  /** Terminate a session (terminal hangup by default on Unix). */
  kill: publicProcedure.input(sessionIdInput).mutation(async ({ ctx, input }) => {
    const client = await ctx.getDaemonClient()
    await client.kill(input.sessionId)
    typingMap(client).delete(input.sessionId)
    return { ok: true as const }
  }),

  /** Live sessions known to the daemon. */
  list: publicProcedure.query(async ({ ctx }) => {
    const client = await ctx.getDaemonClient()
    return client.list()
  }),

  /**
   * One session's output as text, for in-process callers and tests: the screen
   * snapshot and the bytes after it as one leading `data` event, then live
   * `data` events, ending with `exit`. Clients use {@link terminalRouter.output}.
   * MUST be an `observable`: the `trpc-electron` IPC link throws on generators.
   */
  onData: publicProcedure.input(sessionIdInput).subscription(({ ctx, input }) =>
    observable<TerminalEvent>((emit) => {
      // Raw PTY bytes can split a UTF-8 character across chunks.
      const decoder = new TextDecoder()
      return attachSession(ctx, input.sessionId, null, {
        onStart: ({ start }) => {
          const screen = start.mode === "snapshot" ? start.screen : ""
          const chunk = screen + decoder.decode(start.bytes, { stream: true })
          if (chunk.length > 0) emit.next({ type: "data", chunk })
        },
        onEvent: (event) => {
          if (event.kind === "data") {
            ctx.caffeine.markTerminalActivity()
            emit.next({ type: "data", chunk: decoder.decode(event.bytes, { stream: true }) })
          } else if (event.kind === "exit") {
            emit.next({ type: "exit", exitCode: event.exitCode, signal: event.signal })
            emit.complete()
          }
        },
        onError: (error) => emit.error(error),
      })
    }),
  ),

  /**
   * One session's output for clients, with resume (see {@link TerminalOutput}).
   * Each event is `tracked()` with the resume point after it. The client owns
   * its resume point (the bytes its emulator consumed) and subscribes again
   * with it after a drop; tRPC's own `lastEventId` is ignored, because it is
   * the last received event, not the last consumed one. An async generator,
   * because tRPC types `tracked()` events only for generators; clients reach
   * it over WebSocket only, never over the IPC link.
   */
  output: publicProcedure.input(outputInput).subscription(async function* ({ ctx, input, signal }) {
    let generation = ""
    let offset = 0
    let revision = 0
    let ended = false
    let failure: Error | null = null
    const ready: TrackedEnvelope<TerminalOutput>[] = []
    let wake: () => void = () => {}
    const send = (event: TerminalOutput): void => {
      ready.push(tracked(resumeId(generation, offset, revision), event))
      wake()
    }
    const end = (): void => {
      ended = true
      wake()
    }
    const detach = attachSession(ctx, input.sessionId, input.resume, {
      onStart: (result) => {
        generation = result.generation
        revision = result.revision
        const { start } = result
        offset = start.offset + start.bytes.length
        const common = {
          type: "start" as const,
          generation,
          revision,
          cols: result.cols,
          rows: result.rows,
          offset: start.offset,
          base64: start.bytes.toString("base64"),
        }
        send(
          start.mode === "snapshot"
            ? { ...common, mode: "snapshot", screen: start.screen }
            : { ...common, mode: "replay" },
        )
      },
      onEvent: (event) => {
        if (ended) return
        if (event.kind === "exit") {
          send({ type: "exit", exitCode: event.exitCode, signal: event.signal })
          end()
          return
        }
        // A slow reader: stop sending to this connection and let it resubscribe.
        if ((ctx.connection?.queuedBytes() ?? 0) > OUTPUT_QUEUE_LIMIT_BYTES) {
          ctx.connection?.sentBehind()
          send({ type: "behind" })
          end()
          return
        }
        if (event.kind === "data") {
          ctx.caffeine.markTerminalActivity()
          offset = event.offset + event.bytes.length
          send({ type: "data", offset: event.offset, base64: event.bytes.toString("base64") })
        } else {
          revision = event.revision
          send({
            type: "resize",
            offset: event.offset,
            revision: event.revision,
            cols: event.cols,
            rows: event.rows,
          })
        }
      },
      onError: (error) => {
        failure = error
        end()
      },
    })
    const onAbort = () => wake()
    signal?.addEventListener("abort", onAbort)
    try {
      while (!signal?.aborted) {
        const next = ready.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        if (failure !== null) throw failure
        if (ended) return
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        wake = () => {}
      }
    } finally {
      signal?.removeEventListener("abort", onAbort)
      detach()
    }
  }),
})
