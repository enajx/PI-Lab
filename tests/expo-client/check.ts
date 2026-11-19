// The reconnect check run by this Expo app (driven by run-check.mjs).
// It uses the desktop client code as is: the two-socket tRPC links
// (renderer/trpc/serverLinks.ts) over React Native's WebSocket, plain JSON, and
// the terminal stream with resume (renderer/Terminal/terminalStream.ts). The
// emulator only records the bytes it applies and their offsets:
// @xterm/headless 5.5.0 does not load under Hermes (it reads
// `navigator.userAgent`, which React Native leaves undefined, and throws
// "Cannot read property 'includes' of undefined" at import). It reports what it
// received and applied to the collector that run-check.mjs starts on the Mac.

import { createTRPCClient } from "@trpc/client"
import type { ServerRouter } from "../../apps/desktop/src/main/trpc/serverRouter"
import {
  type ResumePoint,
  type SubscribeOutput,
  type TerminalEmulator,
  TerminalStream,
} from "../../apps/desktop/src/renderer/Terminal/terminalStream"
import {
  type ConnectionState,
  ConnectionStatus,
} from "../../apps/desktop/src/renderer/trpc/connectionStatus"
import { createServerSockets } from "../../apps/desktop/src/renderer/trpc/serverLinks"

/** What the collector gives the app at launch. */
export interface CheckParams {
  /** `ws://host:port/trpc?token=...` */
  trpcUrl: string
  /** `http://host:port` of the test's collector. */
  collector: string
  sessionId: string
  cols: number
  rows: number
}

async function post(collector: string, path: string, body: object): Promise<unknown> {
  const response = await fetch(`${collector}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`collector ${path}: HTTP ${response.status}`)
  return response.json()
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

function encodeBase64(bytes: Uint8Array): string {
  let text = ""
  for (let at = 0; at < bytes.length; at += 8192) {
    text += String.fromCharCode(...bytes.subarray(at, at + 8192))
  }
  return btoa(text)
}

/** Received event, as seen by the subscription (before the stream applies it). */
interface Received {
  subscription: number
  id: string
  type: string
  mode?: string
  offset?: number
  length?: number
}

/**
 * Run the check and post the result. Errors are posted as `{ ok: false }` and
 * thrown again, so a failure reaches the test and the screen.
 */
export async function runCheck(params: CheckParams, log: (line: string) => void): Promise<void> {
  const say = (line: string) => {
    log(line)
    void post(params.collector, "/log", { line }).catch(() => undefined)
  }
  try {
    await check(params, say)
  } catch (error) {
    const message =
      error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
    say(`FAILED: ${message}`)
    await post(params.collector, "/result", { ok: false, error: message })
    throw error
  }
}

async function check(params: CheckParams, say: (line: string) => void): Promise<void> {
  const status = new ConnectionStatus()
  const states: ConnectionState[] = []
  status.subscribe(() => states.push(status.state()))
  const sockets = createServerSockets<ServerRouter>({
    url: async () => params.trpcUrl,
    WebSocket: globalThis.WebSocket,
    status,
  })
  const trpc = createTRPCClient<ServerRouter>({ links: [sockets.link] })
  await trpc.terminal.list.query()
  say("calls socket open")

  // Bytes applied to the emulator since the last reset, and where they start.
  let applied: number[] = []
  let appliedStart: number | null = null
  const appliedRanges: [number, number][] = []
  let held: (() => void)[] | null = null
  let stream: TerminalStream | null = null

  const emulator: TerminalEmulator = {
    write: (data, done) => {
      // Applied on a later tick, as xterm.js does.
      const run = () =>
        setTimeout(() => {
          done()
          // A snapshot's write (full reset, then the screen text) is not part of the byte stream.
          if (typeof data === "string") {
            if (data.startsWith("\x1bc")) {
              applied = []
              appliedStart = null
            }
            return
          }
          if (stream === null) return
          const end = stream.consumed()?.offset
          if (end === undefined) throw new Error("applied bytes but no consumed offset")
          if (appliedStart === null) appliedStart = end - data.length
          appliedRanges.push([end - data.length, end])
          for (const byte of data) applied.push(byte)
        }, 0)
      if (held) held.push(run)
      else run()
    },
    resize: () => {},
  }

  const subscribeInputs: (ResumePoint | null)[] = []
  const received: Received[] = []
  const lastReceivedAtSubscribe: (string | null)[] = []
  const subscribe: SubscribeOutput = (input, handlers) => {
    subscribeInputs.push(input.resume)
    lastReceivedAtSubscribe.push(received.at(-1)?.id ?? null)
    const subscription = subscribeInputs.length
    return trpc.terminal.output.subscribe(input, {
      ...handlers,
      onData: (event) => {
        const data = event.data
        const entry: Received = { subscription, id: event.id, type: data.type }
        if (data.type === "start") {
          entry.mode = data.mode
          entry.offset = data.offset
          entry.length = atob(data.base64).length
        } else if (data.type === "data") {
          entry.offset = data.offset
          entry.length = atob(data.base64).length
        }
        received.push(entry)
        handlers.onData(event)
      },
    })
  }

  let streamError: string | null = null
  stream = new TerminalStream({
    subscribe,
    ack: (input) => trpc.terminal.ack.mutate(input),
    sessionId: params.sessionId,
    emulator,
    dropPolicy: "discard",
    onSize: () => {},
    onStart: () => {},
    onEcho: () => {},
    onEchoAck: () => {},
    onExit: () => {
      streamError = "the program exited"
    },
    onError: (message) => {
      streamError = message
    },
  })
  const current = stream
  const checkError = () => {
    if (streamError !== null) throw new Error(`terminal stream: ${streamError}`)
  }
  current.open()
  await waitFor(() => (checkError(), current.consumed() !== null), 15_000, "the first start")
  const attached = current.consumed()
  if (attached === null) throw new Error("no consumed point after the first start")
  const snapshotOffset = attached.offset
  say(`attached: ${current.starts.join(",")} at ${snapshotOffset}`)
  // The snapshot's held bytes start before the consumed point, at appliedStart.
  await post(params.collector, "/attached", { point: attached, bytesFrom: appliedStart })

  await waitFor(
    () => (checkError(), (current.consumed()?.offset ?? 0) > snapshotOffset + 2_000),
    15_000,
    "output",
  )
  // Received but not applied: the last received id is ahead of the consumed offset.
  held = []
  await waitFor(() => current.queued() > 0, 5_000, "a queued chunk")
  say(`holding at ${current.consumed()?.offset}, queued ${current.queued()}; asking for a drop`)
  await post(params.collector, "/drop", {})
  await new Promise((resolve) => setTimeout(resolve, 50))
  const release = held
  held = null
  for (const run of release) run()

  await waitFor(() => (checkError(), subscribeInputs.length >= 2), 15_000, "the resubscription")
  await waitFor(() => (checkError(), current.starts.length >= 2), 15_000, "the second start")
  say(`resubscribed from ${subscribeInputs[1]?.offset}; starts ${current.starts.join(",")}`)

  const { endOffset } = (await post(params.collector, "/resumed", {})) as { endOffset: number }
  await waitFor(
    () => (checkError(), current.consumed()?.offset === endOffset && current.queued() === 0),
    15_000,
    `the end offset ${endOffset}`,
  )
  say(`done at ${endOffset}`)
  await post(params.collector, "/result", {
    ok: true,
    starts: current.starts,
    subscribeInputs,
    lastReceivedAtSubscribe,
    received,
    appliedStart,
    appliedRanges,
    appliedBase64: encodeBase64(Uint8Array.from(applied)),
    consumed: current.consumed(),
    states,
    finalState: status.state(),
  })
  current.close()
  await sockets.close()
}
