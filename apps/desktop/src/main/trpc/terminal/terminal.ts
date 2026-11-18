import type {
  AttachResult,
  DaemonClient,
  DataEvent,
  EchoAckEvent,
  EchoEvent,
  ExitEvent,
  InputFlags,
  ResizeEvent,
  ResumePoint,
} from "@pi-lab/pty-daemon"
import { type TrackedEnvelope, tracked } from "@trpc/server"
import { observable } from "@trpc/server/observable"
import { z } from "zod"
import type { AppContext } from "../context"
import { publicProcedure, router } from "../trpc"
import type { FlowItem } from "./outputFlow"

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
  /**
   * A typed key (with `clientId`; absent from released clients and for other
   * writes): its number in this client's sequence, the client's consumed point
   * when it was typed, and whether this is its first send on the connection it
   * was typed on. The daemon writes it at most once (see `KeyInput` in
   * @pi-lab/pty-daemon) and sends an echo ack for it in the output stream.
   */
  key: z
    .object({
      seq: z.number().int().nonnegative(),
      typedAt: z
        .object({ generation: z.string().min(1), offset: z.number().int().nonnegative() })
        .nullable(),
      firstSend: z.boolean(),
    })
    .optional(),
})

const sendMessageInput = z.object({
  sessionId: z.string(),
  /** One per message; a resend after a lost reply uses the same ID. */
  messageId: z.string().min(1).max(200),
  text: z.string(),
  clientId: z.string().min(1),
})

/** How many compose-line message IDs the server keeps; older ones are forgotten first. */
const MESSAGE_ID_LIMIT = 500

/**
 * Message ID → the write of that message, for the server's lifetime (in
 * memory, last {@link MESSAGE_ID_LIMIT}). A failed write is forgotten, so a
 * resend writes it again.
 */
const sentMessages = new Map<string, Promise<void>>()

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
 * Fallback only (flow control in `outputFlow.ts` keeps the send queue near the
 * connection cap): when more than this many bytes wait in a client
 * connection's send queue, `terminal.output` logs it, stops sending to that
 * connection and tells the client its stream is behind.
 */
export const OUTPUT_QUEUE_LIMIT_BYTES = 4 * 1024 * 1024

/**
 * A client that typed into a terminal keeps its PTY size for this long: another
 * client's focus does not take the size from it (`terminal.resize`).
 */
export const TYPING_HOLDS_SIZE_MS = 3_000

/** When a client last typed into each session (epoch ms), for typing priority in the output scheduler. */
const lastTypedAt = new Map<string, number>()

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
  /** Random per subscription; the client's acks name it. */
  streamId: z.string().min(1).max(100),
  /** The client holds skips while the user has a selection or has scrolled up. */
  holdSkip: z.boolean(),
  /** A terminal shown again: replay from `resume` whenever the daemon still has the bytes. */
  preferReplay: z.literal(true).optional(),
})

const ackInput = z.object({
  streamId: z.string().min(1).max(100),
  /** The client's emulator applied every byte before this offset. */
  offset: z.number().int().nonnegative(),
  holdSkip: z.boolean(),
})

/**
 * What `terminal.output` streams. Bytes are raw PTY output in base64; offsets
 * count raw bytes since spawn.
 * - start: first event. `replay` continues from the requested offset; for a
 *   `snapshot`, reset the emulator to `cols`x`rows`, write `screen` (which holds
 *   exactly the bytes before `offset`), then the bytes. A `refresh` applies
 *   only to an emulator at `base` (its resume point; otherwise ask for a
 *   snapshot): resize to `cols`x`rows` if it differs, write `screen` without a
 *   reset (it keeps the emulator's history), then the bytes. After any start
 *   the emulator is at (`generation`, `offset` + bytes, `revision`). A later
 *   `start` comes after a skip (a refresh or a snapshot) or after the server
 *   attached to the daemon again.
 * - data: the bytes starting at `offset`.
 * - resize: the PTY size changed after every byte before `offset`; the screen
 *   is now at `revision`.
 * - echo: the PTY's ECHO or ICANON flag changed at `offset` (every start
 *   also carries both); local echo predicts nothing while ECHO is off and
 *   ICANON on (a hidden prompt).
 * - echoAck: client `clientId`'s key `seq` was written about 50 ms before the
 *   bytes at `offset`; its echo, if any, is before `offset`.
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
      input: InputFlags
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
      input: InputFlags
    }
  | {
      type: "start"
      generation: string
      revision: number
      cols: number
      rows: number
      mode: "refresh"
      base: ResumePoint
      offset: number
      screen: string
      base64: string
      input: InputFlags
    }
  | { type: "echo"; offset: number; input: InputFlags }
  | { type: "echoAck"; clientId: string; seq: number; offset: number; input: InputFlags }
  | { type: "data"; offset: number; base64: string }
  | { type: "resize"; offset: number; revision: number; cols: number; rows: number }
  | { type: "exit"; exitCode: number | null; signal: number | null }
  | { type: "behind" }

/** The tracked id of a terminal event: the resume point after applying it. */
function resumeId(generation: string, offset: number, revision: number): string {
  return `${generation}:${offset}:${revision}`
}

type SessionEvent = DataEvent | ResizeEvent | EchoEvent | EchoAckEvent | ExitEvent

interface SessionAttachment {
  /** Runs at the attach reply boundary, before any later event. */
  onStart: (result: AttachResult) => void
  /** Live events after the start, in daemon order. */
  onEvent: (event: SessionEvent) => void
  onError: (error: Error) => void
}

interface SessionAttachmentHandle {
  detach: () => void
  /**
   * Ask the daemon for the session's latest screen on the same shared
   * connection (other observers are not affected), for a client at `from`:
   * the daemon answers with a small replay, a refresh or a snapshot. `onStart`
   * runs at the reply boundary: every event after it follows that start.
   */
  snapshot: (from: ResumePoint | null, onStart: (result: AttachResult) => void) => Promise<void>
}

/**
 * Attach to a session on the shared daemon connection and forward its events
 * from the attach reply on. When that connection closes (the daemon dropped a
 * slow reader, or the socket broke), attach again on the supervisor's next
 * connection from the last forwarded point: the daemon answers with a replay
 * or a snapshot (its resume rules), passed to `onStart` like the first start.
 * Only a failed attach (for example, the session is gone after a daemon
 * restart) reaches `onError`. Returns the cleanup, which detaches the daemon
 * connection when the last observer of the session leaves, and the snapshot
 * request.
 */
function attachSession(
  ctx: AppContext,
  sessionId: string,
  resume: ResumePoint | null,
  preferReplay: boolean,
  handlers: SessionAttachment,
): SessionAttachmentHandle {
  let cancelled = false
  /** The daemon connection of the current attachment, while it is open. */
  let current: DaemonClient | null = null
  let cleanup = () => {}
  /** The resume point after the last start or event forwarded to the handlers. */
  let point: ResumePoint | null = resume

  const attachOnce = async (from: ResumePoint | null, replay: boolean): Promise<void> => {
    let attaching = true
    let closed = false
    const client = await ctx.getDaemonClient()
    if (cancelled) return
    current = client
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
    const onClose = () => {
      closed = true
      if (current === client) current = null
      client.off(eventName, onEvent)
      cleanup = () => {}
      if (!cancelled) run(point, true)
    }
    listeners.add(onClose)
    observers.set(sessionId, listeners)
    const watchedObservers = observers
    cleanup = () => {
      client.off(eventName, onEvent)
      listeners.delete(onClose)
      if (listeners.size === 0) {
        watchedObservers.delete(sessionId)
        void client.detach(sessionId).catch(() => {})
      }
      cleanup = () => {}
    }
    try {
      await client.attach(
        sessionId,
        from,
        (result) => {
          if (cancelled) return
          point = {
            generation: result.generation,
            offset: result.start.offset + result.start.bytes.length,
            revision: result.revision,
          }
          handlers.onStart(result)
          attaching = false
        },
        replay ? true : undefined,
      )
    } catch (error) {
      // The connection closed during the attach: onClose attaches again.
      if (closed) return
      throw error
    }
  }

  const run = (from: ResumePoint | null, afterClose: boolean): void => {
    attachOnce(from, !afterClose && preferReplay).catch((error: unknown) => {
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

  return {
    detach: () => {
      cancelled = true
      cleanup()
    },
    snapshot: async (from, onStart) => {
      const client = current
      if (client === null) throw new Error("not attached to the daemon")
      await client.attach(sessionId, from, (result) => {
        if (!cancelled) onStart(result)
      })
    },
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
    if (input.clientId !== undefined) {
      typingMap(client).set(input.sessionId, { clientId: input.clientId, at: Date.now() })
      lastTypedAt.set(input.sessionId, Date.now())
    }
    if (input.clientId !== undefined && input.key !== undefined) {
      const status = await client.writeKey(input.sessionId, input.data, {
        clientId: input.clientId,
        ...input.key,
      })
      // A duplicate or dropped key was not written now.
      if (status === "applied") ctx.activityMonitor.userInput(input.sessionId, input.data)
      ctx.caffeine.markTerminalActivity()
      return { ok: true as const, status }
    }
    ctx.activityMonitor.userInput(input.sessionId, input.data)
    await client.write(input.sessionId, input.data)
    ctx.caffeine.markTerminalActivity()
    return { ok: true as const, status: "applied" as const }
  }),

  /**
   * Send a compose-line message (the text and Enter; the daemon wraps it in
   * bracketed paste when the program turned that mode on). Accepted once per
   * `messageId`: a resend after a lost reply gets `duplicate` and writes nothing.
   */
  sendMessage: publicProcedure.input(sendMessageInput).mutation(async ({ ctx, input }) => {
    const existing = sentMessages.get(input.messageId)
    if (existing !== undefined) {
      await existing
      return { status: "duplicate" as const }
    }
    // Registered before any await, so a resend that arrives meanwhile finds it.
    const written = (async () => {
      const client = await ctx.getDaemonClient()
      ctx.activityMonitor.userInput(input.sessionId, `${input.text}\r`)
      typingMap(client).set(input.sessionId, { clientId: input.clientId, at: Date.now() })
      lastTypedAt.set(input.sessionId, Date.now())
      await client.writeMessage(input.sessionId, input.text)
    })()
    sentMessages.set(input.messageId, written)
    written.catch(() => {
      if (sentMessages.get(input.messageId) === written) sentMessages.delete(input.messageId)
    })
    while (sentMessages.size > MESSAGE_ID_LIMIT) {
      const oldest = sentMessages.keys().next().value
      if (oldest === undefined) break
      sentMessages.delete(oldest)
    }
    await written
    ctx.caffeine.markTerminalActivity()
    return { status: "sent" as const }
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
    lastTypedAt.delete(input.sessionId)
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
      const attachment = attachSession(ctx, input.sessionId, null, false, {
        onStart: ({ start }) => {
          const screen = start.mode === "replay" ? "" : start.screen
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
      return attachment.detach
    }),
  ),

  /**
   * The client applied every byte before `offset` on stream `streamId` (sent
   * on the terminal socket, so it reaches the connection that carries the
   * stream). Frees that much of the stream's window and the connection's cap.
   * `known` is false for a stream not open on this connection (ended).
   */
  ack: publicProcedure.input(ackInput).mutation(({ ctx, input }) => {
    const known =
      ctx.connection?.outputFlow.ack(input.streamId, input.offset, input.holdSkip) ?? false
    return { ok: true as const, known }
  }),

  /**
   * One session's output for clients, with resume (see {@link TerminalOutput})
   * and flow control (`outputFlow.ts`): the client acks what its emulator
   * applied (`terminal.ack`); the stream sends while its window and the
   * connection's cap have room, and skips to the latest screen when its
   * backlog overflows. Each event is `tracked()` with the resume point after
   * it. The client owns its resume point (the bytes its emulator consumed) and
   * subscribes again with it after a drop; tRPC's own `lastEventId` is
   * ignored, because it is the last received event, not the last consumed one.
   * An async generator, because tRPC types `tracked()` events only for
   * generators; clients reach it over WebSocket only, never over the IPC link.
   */
  output: publicProcedure.input(outputInput).subscription(async function* ({ ctx, input, signal }) {
    const connection = ctx.connection
    if (connection === undefined) {
      throw new Error(
        "terminal.output needs a WebSocket client: its flow control runs on client acks",
      )
    }
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
    const deliver = (item: FlowItem): void => {
      if (ended) return
      if (item.kind === "start") {
        const { result } = item
        const { start } = result
        generation = result.generation
        revision = result.revision
        offset = start.offset + start.bytes.length
        const common = {
          type: "start" as const,
          generation,
          revision,
          cols: result.cols,
          rows: result.rows,
          offset: start.offset,
          base64: start.bytes.toString("base64"),
          input: result.input,
        }
        send(
          start.mode === "snapshot"
            ? { ...common, mode: "snapshot", screen: start.screen }
            : start.mode === "refresh"
              ? { ...common, mode: "refresh", base: start.base, screen: start.screen }
              : { ...common, mode: "replay" },
        )
      } else if (item.kind === "data") {
        offset = item.offset + item.bytes.length
        send({ type: "data", offset: item.offset, base64: item.bytes.toString("base64") })
      } else if (item.kind === "echo") {
        send({ type: "echo", offset: item.offset, input: item.input })
      } else if (item.kind === "echo-ack") {
        send({
          type: "echoAck",
          clientId: item.clientId,
          seq: item.seq,
          offset: item.offset,
          input: item.input,
        })
      } else if (item.kind === "resize") {
        revision = item.revision
        send({
          type: "resize",
          offset: item.offset,
          revision: item.revision,
          cols: item.cols,
          rows: item.rows,
        })
      } else {
        send({ type: "exit", exitCode: item.exitCode, signal: item.signal })
        end()
      }
    }
    /** Fallback: the send queue passed the old 4 MiB limit despite flow control. */
    const behind = (): void => {
      console.warn(
        `[pi-lab] terminal ${input.sessionId}: ${connection.queuedBytes()} bytes queued for a client (over ${OUTPUT_QUEUE_LIMIT_BYTES}); sent behind`,
      )
      connection.sentBehind()
      send({ type: "behind" })
      end()
    }
    const stream = connection.outputFlow.open({
      streamId: input.streamId,
      sessionId: input.sessionId,
      holdSkip: input.holdSkip,
      typedAt: () => lastTypedAt.get(input.sessionId) ?? null,
      deliver,
      requestSnapshot: (from) => {
        attachment
          .snapshot(from, (result) => stream.snapshotReady(result))
          .catch((error: unknown) => {
            // The daemon connection closed, or the session went away: start over from the client's point.
            const message = error instanceof Error ? error.message : String(error)
            console.warn(
              `[pi-lab] terminal ${input.sessionId}: skip snapshot failed (${message}); sent behind`,
            )
            stream.snapshotFailed()
            if (!ended) {
              connection.sentBehind()
              send({ type: "behind" })
              end()
            }
          })
      },
    })
    const attachment = attachSession(
      ctx,
      input.sessionId,
      input.resume,
      input.preferReplay === true,
      {
        onStart: (result) => stream.push({ kind: "start", result }),
        onEvent: (event) => {
          if (ended) return
          if (event.kind === "data") ctx.caffeine.markTerminalActivity()
          if (event.kind !== "exit" && connection.queuedBytes() > OUTPUT_QUEUE_LIMIT_BYTES) {
            behind()
            return
          }
          stream.push(event)
        },
        onError: (error) => {
          failure = error
          end()
        },
      },
    )
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
      stream.close()
      attachment.detach()
    }
  }),
})
