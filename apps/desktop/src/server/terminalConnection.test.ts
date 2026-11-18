// Terminal output, resume and connection done checks (md/plans/multi-machine-step1.md),
// run against the real PI Lab server: ServerRuntime, the loopback HTTP and
// WebSocket listener, the real routers, a real PTY daemon (in-process
// DaemonServer, adopted by the runtime's supervisor) and real PTYs. Each viewer
// is a Node client built from the same client code as the desktop renderer
// (renderer/trpc/serverLinks.ts and renderer/Terminal/terminalStream.ts) with
// an @xterm/headless emulator instead of the renderer's xterm.js.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, type Server, type Socket, connect as tcpConnect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projects } from "@pi-lab/local-db"
import { type DaemonClient, DaemonServer } from "@pi-lab/pty-daemon"
import { createTRPCClient } from "@trpc/client"
import xtermHeadless from "@xterm/headless"
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest"
import { WebSocket } from "ws"
import type { TerminalSupervisor } from "../main/terminal/supervisor"
import type { ServerRouter } from "../main/trpc/serverRouter"
import {
  OUTPUT_QUEUE_LIMIT_BYTES,
  type TerminalOutput,
  TYPING_HOLDS_SIZE_MS,
} from "../main/trpc/terminal/terminal"
import {
  type DropPolicy,
  type ResumePoint,
  type SubscribeOutput,
  type TerminalEmulator,
  TerminalStream,
} from "../renderer/Terminal/terminalStream"
import { type ConnectionState, ConnectionStatus } from "../renderer/trpc/connectionStatus"
import { createServerSockets } from "../renderer/trpc/serverLinks"
import { ensureLocalToken, TOKEN_HEADER } from "./access"
import { type ConnectionStats, type ListeningServer, listen } from "./http"
import type { ServerRuntime } from "./runtime"

const { Terminal: HeadlessTerminal } = xtermHeadless
const NODE = process.execPath
const PROGRAM = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "pty-daemon",
  "src",
  "testPrograms",
  "screenProgram.cjs",
)
/** The flood harness's program: steady output at a set rate on "g", FINAL on "q", or a key echo. */
const FLOOD_PROGRAM = join(__dirname, "..", "..", "..", "..", "tests", "flood", "floodProgram.cjs")
const COLS = 80
const ROWS = 24
const KiB = 1024

vi.mock("electron", () => {
  throw new Error("The PI Lab server loaded electron")
})

let dataDir: string
let daemon: DaemonServer
let runtime: ServerRuntime
let server: ListeningServer
let url: string
let token: string
const clients: Client[] = []
const links: SlowLink[] = []

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "pi-lab-terminal-conn-"))
  process.env.PI_LAB_DATA_DIR = dataDir
  process.env.PI_LAB_SOCKET_PATH = join(dataDir, "daemon.sock")
  daemon = new DaemonServer({ socketPath: join(dataDir, "daemon.sock") })
  await daemon.listen()
  const { ServerRuntime } = await import("./runtime")
  runtime = new ServerRuntime({
    dataDir,
    profileDir: dataDir,
    channel: "alpha",
    packaged: false,
    resourcesDir: join(dataDir, "resources"),
    build: "test-build",
    version: "0.0.0-test",
    port: 0,
  })
  await runtime.start()
  server = await listen({
    port: 0,
    access: runtime.devices,
    localToken: ensureLocalToken(dataDir),
    createContext: () => ({
      ...runtime.createAppContext(),
      server: { runtime, exit: () => undefined },
    }),
    handleScheme: async () => new Response(null, { status: 404 }),
    testRoutes: true,
  })
  token = ensureLocalToken(dataDir)
  url = `ws://127.0.0.1:${server.port}/trpc?token=${encodeURIComponent(token)}`
})

afterEach(async () => {
  for (const client of clients) await client.close()
  clients.length = 0
  for (const link of links) await link.close()
  links.length = 0
})

afterAll(async () => {
  await server?.close()
  runtime?.dispose()
  await daemon?.close()
  rmSync(dataDir, { recursive: true, force: true })
})

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/**
 * One client device: the renderer's two-socket link set and connection status,
 * over `ws`. Every socket it opens is recorded, so a test can kill or pause one.
 * Create it with {@link newClient}, which opens the calls socket first, so every
 * later socket belongs to the terminal link.
 */
class Client {
  readonly status = new ConnectionStatus()
  readonly states: ConnectionState[] = []
  readonly sockets: WebSocket[] = []
  readonly trpc
  readonly #close: () => Promise<void>

  constructor(address: () => string) {
    const sockets = this.sockets
    class RecordedWebSocket extends WebSocket {
      constructor(address: string) {
        super(address)
        sockets.push(this)
      }
    }
    const created = createServerSockets<ServerRouter>({
      url: async () => address(),
      WebSocket: RecordedWebSocket as unknown as typeof globalThis.WebSocket,
      status: this.status,
    })
    this.status.subscribe(() => this.states.push(this.status.state()))
    this.trpc = createTRPCClient<ServerRouter>({ links: [created.link] })
    this.#close = created.close
    clients.push(this)
  }

  close(): Promise<void> {
    return this.#close()
  }

  /** The newest WebSocket of the terminal link. */
  terminalSocket(): WebSocket {
    const found = this.sockets.slice(1).at(-1)
    if (!found) throw new Error("no terminal socket yet")
    return found
  }
}

async function newClient(): Promise<Client> {
  const client = new Client(() => url)
  await client.trpc.terminal.list.query()
  return client
}

/** A client whose two sockets both go through `link` (one shared slow link, as a tunnel). */
async function newClientVia(link: SlowLink): Promise<Client> {
  const client = new Client(() => url.replace(`:${server.port}/`, `:${link.port}/`))
  await client.trpc.terminal.list.query()
  return client
}

/**
 * A slow link stand-in: a TCP proxy in front of the server. Bytes from the
 * server to the client share one rate limit and one FIFO queue across every
 * connection through the link (as the channels of one SSH tunnel do), and
 * bytes go out `delayMs` after they leave the queue, both ways. A server
 * socket is no longer read while the shared queue holds more than 1 MiB, so
 * the rest waits in the server's own send queue.
 */
class SlowLink {
  readonly #tcp: Server
  readonly #sockets = new Set<Socket>()
  readonly #queue: { to: Socket; bytes: Buffer }[] = []
  readonly #upstreams = new Set<Socket>()
  #queued = 0
  #timer: NodeJS.Timeout
  port = 0

  constructor(
    readonly bytesPerSecond: number,
    readonly delayMs: number,
  ) {
    this.#tcp = createServer((downstream) => {
      const upstream = tcpConnect(server.port, "127.0.0.1")
      this.#sockets.add(downstream)
      this.#sockets.add(upstream)
      this.#upstreams.add(upstream)
      downstream.on("data", (bytes) => setTimeout(() => upstream.write(bytes), this.delayMs))
      upstream.on("data", (bytes) => {
        this.#queue.push({ to: downstream, bytes })
        this.#queued += bytes.length
        if (this.#queued > 1024 * KiB) for (const socket of this.#upstreams) socket.pause()
      })
      const end = () => {
        this.#upstreams.delete(upstream)
        downstream.destroy()
        upstream.destroy()
      }
      downstream.on("close", end)
      upstream.on("close", end)
      downstream.on("error", end)
      upstream.on("error", end)
    })
    let last = Date.now()
    this.#timer = setInterval(() => {
      const now = Date.now()
      let budget = ((now - last) * this.bytesPerSecond) / 1000
      last = now
      while (budget > 0 && this.#queue.length > 0) {
        const head = this.#queue[0] as { to: Socket; bytes: Buffer }
        const piece = head.bytes.subarray(0, Math.ceil(budget))
        if (piece.length === head.bytes.length) this.#queue.shift()
        else head.bytes = head.bytes.subarray(piece.length)
        budget -= piece.length
        this.#queued -= piece.length
        const to = head.to
        setTimeout(() => {
          if (!to.destroyed) to.write(piece)
        }, this.delayMs)
      }
      if (this.#queued <= 1024 * KiB) for (const socket of this.#upstreams) socket.resume()
    }, 5)
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve) => this.#tcp.listen(0, "127.0.0.1", resolve))
    this.port = (this.#tcp.address() as { port: number }).port
  }

  async close(): Promise<void> {
    clearInterval(this.#timer)
    for (const socket of this.#sockets) socket.destroy()
    await new Promise<void>((resolve) => this.#tcp.close(() => resolve()))
  }
}

async function slowLink(bytesPerSecond: number, delayMs: number): Promise<SlowLink> {
  const link = new SlowLink(bytesPerSecond, delayMs)
  await link.open()
  links.push(link)
  return link
}

/** The server's per-connection stats (test route): send queue, output cap, skips. */
async function connectionStats(): Promise<ConnectionStats[]> {
  const response = await fetch(`http://127.0.0.1:${server.port}/test/connections`, {
    headers: { [TOKEN_HEADER]: token },
  })
  if (response.status !== 200) throw new Error(`GET /test/connections: HTTP ${response.status}`)
  return (await response.json()) as ConnectionStats[]
}

/** The output stats of the open connection that carries this stream. */
async function streamStats(
  streamId: string,
): Promise<{ connection: ConnectionStats; skips: number; skipPending: boolean }> {
  for (const connection of await connectionStats()) {
    const stream = connection.output.streams.find((entry) => entry.streamId === streamId)
    if (stream) return { connection, skips: stream.skips, skipPending: stream.skipPending }
  }
  throw new Error(`no open stream ${streamId}`)
}

/** Nearest-rank percentile. */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return (
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ??
    NaN
  )
}

/** Spawn tests/flood/floodProgram.cjs; `produced()` reads the PTY bytes it has written. */
async function spawnFlood(
  client: Client,
  mode: "lines" | "fullscreen" | "echo",
  bytesPerSecond: number,
): Promise<{ sessionId: string; produced: () => number }> {
  const counterFile = join(dataDir, `flood-${Math.random().toString(36).slice(2)}.count`)
  const { sessionId } = await client.trpc.terminal.spawn.mutate({
    command: NODE,
    args: [FLOOD_PROGRAM, mode, String(bytesPerSecond), counterFile],
    cols: COLS,
    rows: ROWS,
  })
  return {
    sessionId,
    produced: () => (existsSync(counterFile) ? Number(readFileSync(counterFile, "utf8")) || 0 : 0),
  }
}

/** A terminal view: a headless emulator fed by a {@link TerminalStream}. */
class Viewer {
  readonly terminal = new HeadlessTerminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
  readonly stream: TerminalStream
  readonly subscribeInputs: (ResumePoint | null)[] = []
  /** The stream id of each subscription, oldest first. */
  readonly streamIds: string[] = []
  /** Every event received, with when it arrived (ms, performance clock). */
  readonly received: { at: number; type: string }[] = []
  /** Ids (resume points) of every event received, in order. */
  readonly receivedIds: string[] = []
  /** Server errors that ended the stream. */
  readonly errors: string[] = []
  /** Each start received: its mode and its size (screen plus base64 bytes). */
  readonly startSizes: { mode: string; bytes: number }[] = []
  /** Test hook: change an event before the stream sees it. */
  tamper: ((data: TerminalOutput) => TerminalOutput) | null = null
  #held: (() => void)[] | null = null
  exited = false

  constructor(client: Client, sessionId: string, dropPolicy: DropPolicy) {
    const subscribe: SubscribeOutput = (input, handlers) => {
      this.subscribeInputs.push(input.resume)
      this.streamIds.push(input.streamId)
      return client.trpc.terminal.output.subscribe(input, {
        ...handlers,
        onData: (event) => {
          this.receivedIds.push(event.id)
          this.received.push({ at: performance.now(), type: event.data.type })
          const data = event.data
          if (data.type === "start")
            this.startSizes.push({
              mode: data.mode,
              bytes: (data.mode === "replay" ? 0 : data.screen.length) + data.base64.length,
            })
          handlers.onData({ ...event, data: this.tamper ? this.tamper(data) : data })
        },
      })
    }
    const emulator: TerminalEmulator = {
      write: (data, applied) => {
        const run = () => this.terminal.write(data, applied)
        if (this.#held) this.#held.push(run)
        else run()
      },
      resize: (cols, rows) => this.terminal.resize(cols, rows),
    }
    this.stream = new TerminalStream({
      subscribe,
      ack: (input) => client.trpc.terminal.ack.mutate(input),
      sessionId,
      emulator,
      dropPolicy,
      onSize: () => {},
      onStart: () => {},
      onEcho: () => {},
      onEchoAck: () => {},
      onExit: () => {
        this.exited = true
      },
      onError: (message) => {
        this.errors.push(message)
        throw new Error(`terminal stream error: ${message}`)
      },
    })
    this.stream.open()
  }

  /** Stop applying writes (the emulator is busy); later events queue in the stream. */
  hold(): void {
    this.#held = []
  }

  release(): void {
    const held = this.#held ?? []
    this.#held = null
    for (const run of held) run()
  }

  screen(): string {
    const buffer = this.terminal.buffer.active
    const lines: string[] = []
    for (let row = 0; row < this.terminal.rows; row++) {
      lines.push(buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "")
    }
    return lines.join("\n")
  }

  /** Every line of the active buffer, scrollback included. */
  allLines(): string[] {
    const buffer = this.terminal.buffer.active
    const lines: string[] = []
    for (let row = 0; row < buffer.length; row++) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? "")
    }
    return lines
  }

  /** What a later byte or key depends on: size, buffer, cursor, modes and the text. */
  state(): object {
    const buffer = this.terminal.buffer.active
    return {
      size: [this.terminal.cols, this.terminal.rows],
      buffer: buffer.type,
      cursor: [buffer.cursorX, buffer.cursorY],
      modes: this.terminal.modes,
      text: this.screen(),
    }
  }
}

async function spawnProgram(client: Client, scenario: string): Promise<string> {
  const { sessionId } = await client.trpc.terminal.spawn.mutate({
    command: NODE,
    args: [PROGRAM, scenario],
    cols: COLS,
    rows: ROWS,
  })
  return sessionId
}

/** Wait until both viewers applied the same bytes and show FINAL, then compare. */
async function expectSameEnd(reference: Viewer, viewer: Viewer): Promise<void> {
  await waitFor(
    () =>
      reference.screen().includes("FINAL") &&
      viewer.stream.consumed()?.offset === reference.stream.consumed()?.offset &&
      viewer.stream.queued() === 0,
    15_000,
    "both viewers to reach FINAL at the same offset",
  )
  expect(viewer.state()).toEqual(reference.state())
}

for (const dropPolicy of ["keep", "discard"] as const) {
  test(`resume (${dropPolicy} the queued chunk): drop the terminal socket while a chunk is queued; the screen equals an uninterrupted client`, async () => {
    const control = await newClient()
    const sessionId = await spawnProgram(control, "fullscreen")
    const reference = new Viewer(await newClient(), sessionId, "keep")
    const viewerClient = await newClient()
    const viewer = new Viewer(viewerClient, sessionId, dropPolicy)
    await waitFor(() => viewer.screen().includes("R"), 10_000, "the program to start")
    await control.trpc.terminal.write.mutate({ sessionId, data: "g" })
    await waitFor(() => (viewer.stream.consumed()?.offset ?? 0) > 2_000, 10_000, "output")

    viewer.hold()
    await waitFor(() => viewer.stream.queued() > 0, 5_000, "a queued chunk")
    const consoleError = vi.spyOn(console, "error")
    viewerClient.terminalSocket().terminate()
    // The stream resubscribes only once the held write is applied.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(viewer.subscribeInputs.length).toBe(1)
    if (dropPolicy === "keep") expect(viewer.stream.queued()).toBeGreaterThan(0)
    else expect(viewer.stream.queued()).toBe(0)
    viewer.release()
    await waitFor(() => viewer.subscribeInputs.length === 2, 5_000, "the resubscription")
    // Output continues while the viewer catches up.
    await new Promise((resolve) => setTimeout(resolve, 200))
    await control.trpc.terminal.write.mutate({ sessionId, data: "q" })

    await expectSameEnd(reference, viewer)
    // Every byte applied exactly once: a gap or overlap would have forced a snapshot.
    // A full-screen app gets a refresh when the replay is longer than it.
    expect(viewer.stream.starts[0]).toBe("snapshot")
    expect(["replay", "refresh"]).toContain(viewer.stream.starts[1])
    expect(viewer.stream.starts).toHaveLength(2)
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
    await control.trpc.terminal.kill.mutate({ sessionId })
  }, 30_000)
}

test("Expo stand-in (a Node client running the same tRPC client code): a killed tunnel resumes with a short replay from its consumed offset while output continues", async () => {
  const control = await newClient()
  const sessionId = await spawnProgram(control, "stream")
  const reference = new Viewer(await newClient(), sessionId, "keep")
  const phone = await newClient()
  const viewer = new Viewer(phone, sessionId, "discard")
  await waitFor(() => viewer.screen().includes("R"), 10_000, "the program to start")
  await control.trpc.terminal.write.mutate({ sessionId, data: "g" })
  await waitFor(() => (viewer.stream.consumed()?.offset ?? 0) > 2_000, 10_000, "output")

  // Received but not applied: the last received id is ahead of the consumed offset.
  viewer.hold()
  await waitFor(() => viewer.stream.queued() > 0, 5_000, "a queued chunk")
  // The server closes every connection, as a killed SSH tunnel would.
  server.dropConnections()
  await new Promise((resolve) => setTimeout(resolve, 50))
  viewer.release()
  await waitFor(() => viewer.subscribeInputs.length === 2, 5_000, "the resubscription")
  const resume = viewer.subscribeInputs[1]
  const lastReceived = Number(viewer.receivedIds.at(-2)?.split(":")[1])
  expect(resume).not.toBeNull()
  expect(resume?.offset).toBeLessThan(lastReceived)
  await waitFor(() => viewer.stream.starts.length === 2, 5_000, "the second start")
  expect(viewer.stream.starts).toEqual(["snapshot", "replay"])

  await new Promise((resolve) => setTimeout(resolve, 200))
  await control.trpc.terminal.write.mutate({ sessionId, data: "q" })
  await expectSameEnd(reference, viewer)
  expect(phone.states).toContain("reconnecting")
  expect(phone.status.state()).toBe("connected")
  await control.trpc.terminal.kill.mutate({ sessionId })
}, 30_000)

test("a slow reader (socket not read) is sent at most the connection cap, then skips to the latest screen when it reads again", async () => {
  const control = await newClient()
  // Writes 48 MiB of output in 64 KiB writes on "g", then FINAL, then stays silent.
  const { sessionId } = await control.trpc.terminal.spawn.mutate({
    command: NODE,
    args: [
      "-e",
      [
        "process.stdin.setRawMode(true)",
        "const line = 'flood ' + 'y'.repeat(73) + '\\n'",
        "const chunk = line.repeat(Math.floor(65536 / line.length))",
        "let left = Math.ceil(48 * 1024 * 1024 / chunk.length)",
        "const pump = () => { while (left > 0) { left--; if (!process.stdout.write(chunk)) { process.stdout.once('drain', pump); return } } process.stdout.write('FINAL\\n') }",
        "process.stdin.on('data', (d) => { if (d.toString() === 'g') pump() })",
        "setInterval(() => {}, 1000)",
        "process.stdout.write('R')",
      ].join(";"),
    ],
    cols: COLS,
    rows: ROWS,
  })
  const reference = new Viewer(await newClient(), sessionId, "keep")
  const slow = await newClient()
  const viewer = new Viewer(slow, sessionId, "keep")
  await waitFor(() => viewer.screen().includes("R"), 10_000, "the program to start")

  // Stop reading the terminal socket: the server's send queue for it grows.
  const socket = slow.terminalSocket()
  const tcp = (socket as unknown as { _socket: import("node:net").Socket })._socket
  let bytesWhilePaused = 0
  let paused = true
  let behind = false
  socket.on("message", (data: Buffer) => {
    if (paused) bytesWhilePaused += data.length
    if (data.includes('"type":"behind"')) behind = true
  })
  tcp.pause()
  await control.trpc.terminal.write.mutate({ sessionId, data: "g" })
  // Wait until the program wrote far more than the limit (the reference reads it all).
  await waitFor(
    () => (reference.stream.consumed()?.offset ?? 0) > 3 * OUTPUT_QUEUE_LIMIT_BYTES,
    20_000,
    "output past the limit",
  )
  const streamId = viewer.streamIds[0] as string
  const atPause = await streamStats(streamId)
  // Short of the client's heartbeat timeout, so this is flow control at work.
  tcp.resume()
  await new Promise((resolve) => setTimeout(resolve, 50))
  paused = false

  await waitFor(() => reference.screen().includes("FINAL"), 60_000, "the reference to finish")
  await expectSameEnd(reference, viewer)
  // The connection cap bounds what the server queued for the paused reader (the
  // cap, one event past it, and base64 and JSON framing), far below the old limit.
  expect(atPause.connection.queuedBytes).toBeLessThan(OUTPUT_QUEUE_LIMIT_BYTES / 4)
  expect(bytesWhilePaused).toBeLessThan(1024 * KiB)
  expect(behind).toBe(false)
  // The program never waited: the stream skipped its backlog and sent the latest screen.
  expect(atPause.skips).toBeGreaterThanOrEqual(1)
  expect(viewer.stream.starts.filter((mode) => mode === "snapshot").length).toBeGreaterThanOrEqual(
    2,
  )
  expect(viewer.subscribeInputs.length).toBe(1)
  await control.trpc.terminal.kill.mutate({ sessionId })
}, 120_000)

test("focusing a view takes the PTY size, unless another client typed in the last 3 s", async () => {
  const control = await newClient()
  const sessionId = await spawnProgram(control, "stream")
  const laptop = await newClient()
  const desktop = await newClient()
  await laptop.trpc.terminal.write.mutate({ sessionId, data: "x", clientId: "laptop" })
  expect(
    await desktop.trpc.terminal.resize.mutate({
      sessionId,
      cols: 100,
      rows: 30,
      clientId: "desktop",
    }),
  ).toEqual({ ok: true, applied: false })
  expect(
    await laptop.trpc.terminal.resize.mutate({ sessionId, cols: 90, rows: 28, clientId: "laptop" }),
  ).toEqual({ ok: true, applied: true })
  await new Promise((resolve) => setTimeout(resolve, TYPING_HOLDS_SIZE_MS + 100))
  expect(
    await desktop.trpc.terminal.resize.mutate({
      sessionId,
      cols: 100,
      rows: 30,
      clientId: "desktop",
    }),
  ).toEqual({ ok: true, applied: true })
  const listed = (await control.trpc.terminal.list.query()).find((s) => s.id === sessionId)
  expect([listed?.cols, listed?.rows]).toEqual([100, 30])
  await control.trpc.terminal.kill.mutate({ sessionId })
}, 15_000)

/** The socket of one of the server's daemon connections (private; paused to make the server a slow reader). */
function daemonSocket(client: DaemonClient): Socket {
  const socket = (client as unknown as { socket: Socket | null }).socket
  if (!socket) throw new Error("daemon client is not connected")
  return socket
}

test("the daemon drops the server's slow connections under a flood: every terminal stream continues with the right screen, no client sees an error, and the activity monitor still sees the sessions", async () => {
  const context = runtime.createAppContext()
  const supervisor = (runtime as unknown as { terminalSupervisor: TerminalSupervisor })
    .terminalSupervisor
  const control = await newClient()
  // Writes 48 MiB of output in 64 KiB writes on "g", then FINAL, then stays silent.
  const { sessionId: flood } = await control.trpc.terminal.spawn.mutate({
    command: NODE,
    args: [
      "-e",
      [
        "process.stdin.setRawMode(true)",
        "const line = 'flood ' + 'y'.repeat(73) + '\\n'",
        "const chunk = line.repeat(Math.floor(65536 / line.length))",
        "let left = Math.ceil(48 * 1024 * 1024 / chunk.length)",
        "const pump = () => { while (left > 0) { left--; if (!process.stdout.write(chunk)) { process.stdout.once('drain', pump); return } } process.stdout.write('FINAL\\n') }",
        "process.stdin.on('data', (d) => { if (d.toString() === 'g') pump() })",
        "setInterval(() => {}, 1000)",
        "process.stdout.write('R')",
      ].join(";"),
    ],
    cols: COLS,
    rows: ROWS,
  })
  // A quiet agent: prints a permission question on "p", then FINAL on "q".
  const { sessionId: quiet } = await control.trpc.terminal.spawn.mutate({
    command: NODE,
    args: [
      "-e",
      [
        "process.stdin.setRawMode(true)",
        "process.stdin.on('data', (d) => { const k = d.toString(); if (k === 'p') process.stdout.write('Do you want to proceed? (y/n)\\r\\n'); if (k === 'q') process.stdout.write('FINAL\\r\\n') })",
        "setInterval(() => {}, 1000)",
        "process.stdout.write('R\\r\\n')",
      ].join(";"),
    ],
    cols: COLS,
    rows: ROWS,
  })
  context.db
    .insert(projects)
    .values({ id: "flood-project", repoPath: "/repo", name: "Flood" })
    .run()
  await context.activityMonitor.track({
    sessionId: quiet,
    projectId: "flood-project",
    workspaceId: null,
    agentId: "codex",
    workflowRunId: null,
    origin: "project",
    turnArmed: false,
    cols: COLS,
    rows: ROWS,
  })
  await context.activityMonitor.trackTerminal({
    sessionId: flood,
    projectId: "flood-project",
    workspaceId: "",
    label: "Terminal",
    cols: COLS,
    rows: ROWS,
  })
  const viewerClient = await newClient()
  const floodViewer = new Viewer(viewerClient, flood, "keep")
  const quietViewer = new Viewer(viewerClient, quiet, "keep")
  await waitFor(() => floodViewer.screen().includes("R"), 10_000, "the flood program to start")
  await waitFor(() => quietViewer.screen().includes("R"), 10_000, "the quiet program to start")
  expect(runtime.activityRegistry.get(quiet)?.state).toBe("working")

  const consoleWarn = vi.spyOn(console, "warn")
  const mainSocket = daemonSocket(await context.getDaemonClient())
  const monitorSocket = daemonSocket(await supervisor.ensureMonitorClient())
  await control.trpc.terminal.write.mutate({ sessionId: flood, data: "g" })
  // The server stops reading both daemon connections (an event loop starved by CPU load).
  mainSocket.pause()
  monitorSocket.pause()
  const dropLogs = () =>
    consoleWarn.mock.calls.filter((call) =>
      String(call[0]).includes("[pty-daemon] dropped a client connection"),
    )
  await waitFor(() => dropLogs().length >= 2, 30_000, "the daemon to drop both connections")
  mainSocket.resume()
  monitorSocket.resume()

  // The server logs why the daemon closed each connection.
  await waitFor(
    () =>
      consoleWarn.mock.calls.filter(
        (call) =>
          String(call[0]).includes("[pi-lab] lost the pty-daemon connection") &&
          String(call[0]).includes("pending output"),
      ).length >= 2,
    30_000,
    "the server to log the reason for both connections",
  )
  consoleWarn.mockRestore()

  await waitFor(() => floodViewer.screen().includes("FINAL"), 60_000, "the flood to finish")
  await control.trpc.terminal.write.mutate({ sessionId: quiet, data: "p" })
  await control.trpc.terminal.write.mutate({ sessionId: quiet, data: "q" })
  // A fresh viewer gets the daemon's own screen as a snapshot: the truth to compare with.
  const freshFlood = new Viewer(await newClient(), flood, "keep")
  const freshQuiet = new Viewer(await newClient(), quiet, "keep")
  await expectSameEnd(freshFlood, floodViewer)
  await expectSameEnd(freshQuiet, quietViewer)
  expect(quietViewer.screen()).toContain("Do you want to proceed?")
  expect(floodViewer.errors).toEqual([])
  expect(quietViewer.errors).toEqual([])
  expect(floodViewer.subscribeInputs.length).toBe(1)
  expect(quietViewer.subscribeInputs.length).toBe(1)
  // The activity monitor reattached and saw the question printed after the drop.
  await waitFor(
    () => runtime.activityRegistry.get(quiet)?.state === "waiting",
    10_000,
    "the activity monitor to see the question",
  )
  await control.trpc.terminal.kill.mutate({ sessionId: flood })
  await control.trpc.terminal.kill.mutate({ sessionId: quiet })
}, 120_000)

// ------------------------------------------------------------ flow control
// The output flow control (md/branch-connection-layer.md, "Flow control"),
// through the real server, daemon and PTYs, with the renderer's stream code.
// "Slow link" is the SlowLink TCP proxy above (a stand-in for a tunnel).

/** Wait until a fresh viewer and `viewer` show the same buffer, scrollback included. */
async function expectSameBuffer(viewer: Viewer, sessionId: string): Promise<void> {
  const fresh = new Viewer(await newClient(), sessionId, "keep")
  await expectSameEnd(fresh, viewer)
  expect(viewer.allLines()).toEqual(fresh.allLines())
}

test("slow link: a small call and a quiet terminal's echo stay fast while 4 terminals flood", async () => {
  const control = await newClient()
  // 2 MB/s and 70 ms round trip, shared by both sockets of the client.
  const link = await slowLink(2_000_000, 35)
  const app = await newClientVia(link)
  const floods = []
  for (let index = 0; index < 4; index++)
    floods.push(await spawnFlood(control, "lines", 1024 * KiB))
  const quiet = await spawnFlood(control, "echo", 0)
  const viewers = floods.map((flood) => new Viewer(app, flood.sessionId, "keep"))
  const quietViewer = new Viewer(app, quiet.sessionId, "keep")
  for (const viewer of [...viewers, quietViewer])
    await waitFor(() => viewer.screen().includes("R"), 15_000, "the programs to start")
  // Both sockets are open now; a later "reconnecting" would be a dropped socket.
  const statesBefore = app.states.length
  const socketsBefore = app.sockets.length
  for (const flood of floods)
    await control.trpc.terminal.write.mutate({ sessionId: flood.sessionId, data: "g" })
  await new Promise((resolve) => setTimeout(resolve, 1_000))

  const calls: number[] = []
  const echoes: number[] = []
  const deadline = Date.now() + 6_000
  let letter = 0
  while (Date.now() < deadline) {
    const started = performance.now()
    await app.trpc.server.hello.query()
    calls.push(performance.now() - started)
    const key = "abcdefghijklmnopqrstuvwxyz"[letter++ % 26] as string
    const before = quietViewer.screen()
    const typed = performance.now()
    await app.trpc.terminal.write.mutate({
      sessionId: quiet.sessionId,
      data: key,
      clientId: "laptop",
    })
    await waitFor(() => quietViewer.screen() !== before, 5_000, "the echo")
    echoes.push(performance.now() - typed)
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  // The user's remote limits at a 70 ms round trip.
  expect(percentile(calls, 95)).toBeLessThanOrEqual(400)
  expect(percentile(echoes, 95)).toBeLessThanOrEqual(500)
  expect(app.states.slice(statesBefore)).not.toContain("reconnecting")
  expect(app.sockets.length).toBe(socketsBefore)

  for (const flood of floods)
    await control.trpc.terminal.write.mutate({ sessionId: flood.sessionId, data: "q" })
  for (const [index, viewer] of viewers.entries())
    await expectSameBuffer(viewer, floods[index]?.sessionId as string)
  for (const flood of [...floods, quiet])
    await control.trpc.terminal.kill.mutate({ sessionId: flood.sessionId })
}, 90_000)

test("one slow viewer does not slow another viewer of the same terminal", async () => {
  const control = await newClient()
  const flood = await spawnFlood(control, "lines", 2048 * KiB)
  const fast = new Viewer(await newClient(), flood.sessionId, "keep")
  const slow = new Viewer(await newClientVia(await slowLink(256_000, 20)), flood.sessionId, "keep")
  await waitFor(() => fast.screen().includes("R") && slow.screen().includes("R"), 15_000, "start")
  await control.trpc.terminal.write.mutate({ sessionId: flood.sessionId, data: "g" })
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  const lags: number[] = []
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    lags.push(flood.produced() - (fast.stream.consumed()?.offset ?? 0))
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  // The fast viewer stays within about a quarter second of the program (2 MiB/s).
  expect(percentile(lags, 95)).toBeLessThan(512 * KiB)
  const slowStats = await streamStats(slow.streamIds[0] as string)
  expect(slowStats.skips).toBeGreaterThanOrEqual(1)
  const fastStats = await streamStats(fast.streamIds[0] as string)
  expect(fastStats.skips).toBe(0)
  await control.trpc.terminal.write.mutate({ sessionId: flood.sessionId, data: "q" })
  await expectSameBuffer(fast, flood.sessionId)
  await expectSameBuffer(slow, flood.sessionId)
  await control.trpc.terminal.kill.mutate({ sessionId: flood.sessionId })
}, 60_000)

test("a skip delivers the latest screen and scrollback, with no gap or duplicate afterwards", async () => {
  const control = await newClient()
  const flood = await spawnFlood(control, "lines", 4096 * KiB)
  const viewer = new Viewer(await newClient(), flood.sessionId, "keep")
  await waitFor(() => viewer.screen().includes("R"), 15_000, "start")
  const consoleError = vi.spyOn(console, "error")
  // The emulator stops applying: no acks, so the window fills and the backlog overflows.
  viewer.hold()
  await control.trpc.terminal.write.mutate({ sessionId: flood.sessionId, data: "g" })
  const streamId = viewer.streamIds[0] as string
  await waitFor(async () => (await streamStats(streamId)).skips >= 1, 15_000, "a skip")
  viewer.release()
  await waitFor(() => viewer.stream.starts.length >= 2, 10_000, "the skip's snapshot")
  expect(viewer.stream.starts.slice(0, 2)).toEqual(["snapshot", "snapshot"])
  // Output continues after the skip; every later byte must follow the snapshot exactly.
  await new Promise((resolve) => setTimeout(resolve, 500))
  await control.trpc.terminal.write.mutate({ sessionId: flood.sessionId, data: "q" })
  await expectSameBuffer(viewer, flood.sessionId)
  expect(viewer.subscribeInputs.length).toBe(1)
  expect(consoleError).not.toHaveBeenCalled()
  consoleError.mockRestore()
  await control.trpc.terminal.kill.mutate({ sessionId: flood.sessionId })
}, 60_000)

test("a skip in a full-screen app sends a screen refresh, not the full snapshot", async () => {
  const control = await newClient()
  const flood = await spawnFlood(control, "fullscreen", 4096 * KiB)
  const viewer = new Viewer(await newClient(), flood.sessionId, "keep")
  await waitFor(() => viewer.screen().includes("R"), 15_000, "start")
  const consoleError = vi.spyOn(console, "error")
  viewer.hold()
  await control.trpc.terminal.write.mutate({ sessionId: flood.sessionId, data: "g" })
  const streamId = viewer.streamIds[0] as string
  await waitFor(async () => (await streamStats(streamId)).skips >= 1, 15_000, "a skip")
  viewer.release()
  await waitFor(() => viewer.stream.starts.length >= 2, 10_000, "the skip's start")
  expect(viewer.stream.starts.slice(0, 2)).toEqual(["snapshot", "refresh"])
  expect(viewer.startSizes[1]?.bytes).toBeLessThan(16 * KiB)
  await new Promise((resolve) => setTimeout(resolve, 500))
  await control.trpc.terminal.write.mutate({ sessionId: flood.sessionId, data: "q" })
  await expectSameBuffer(viewer, flood.sessionId)
  expect(viewer.subscribeInputs.length).toBe(1)
  expect(consoleError).not.toHaveBeenCalled()
  consoleError.mockRestore()
  await control.trpc.terminal.kill.mutate({ sessionId: flood.sessionId })
}, 60_000)

test("a refresh made for another screen (wrong base) is refused: the client asks for a snapshot and ends with the right screen", async () => {
  const control = await newClient()
  const sessionId = await spawnProgram(control, "tui")
  const viewerClient = await newClient()
  const viewer = new Viewer(viewerClient, sessionId, "keep")
  await waitFor(() => viewer.screen().includes("R"), 15_000, "the program to start")
  await control.trpc.terminal.write.mutate({ sessionId, data: "g" })
  await waitFor(() => (viewer.stream.consumed()?.offset ?? 0) > 2_000, 10_000, "output")
  // The next refresh claims a base one byte before the client's point.
  viewer.tamper = (data) =>
    data.type === "start" && data.mode === "refresh"
      ? { ...data, base: { ...data.base, offset: data.base.offset - 1 } }
      : data
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
  viewer.stream.setVisible(false)
  // Enough output while hidden that the daemon sends a refresh, not a small replay.
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  viewer.stream.setVisible(true)
  await waitFor(() => viewer.stream.starts.length === 3, 10_000, "the snapshot after the refusal")
  expect(viewer.stream.starts).toEqual(["snapshot", "refresh", "snapshot"])
  expect(viewer.subscribeInputs.at(-1)).toBeNull()
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("does not fit the screen"))
  consoleError.mockRestore()
  viewer.tamper = null
  const reference = new Viewer(await newClient(), sessionId, "keep")
  await control.trpc.terminal.write.mutate({ sessionId, data: "q" })
  await expectSameEnd(reference, viewer)
  await control.trpc.terminal.kill.mutate({ sessionId })
}, 30_000)

test("a hidden terminal gets no output, and resumes correctly when shown (a small replay, else a snapshot for log lines)", async () => {
  const control = await newClient()
  const slowFlood = await spawnFlood(control, "lines", 8 * KiB)
  const viewer = new Viewer(await newClient(), slowFlood.sessionId, "keep")
  await waitFor(() => viewer.screen().includes("R"), 15_000, "start")

  viewer.stream.setVisible(false)
  await waitFor(
    async () =>
      (await connectionStats()).every((entry) =>
        entry.output.streams.every((stream) => stream.sessionId !== slowFlood.sessionId),
      ),
    5_000,
    "the hidden terminal's stream to end on the server",
  )
  const receivedWhileShown = viewer.received.length
  await control.trpc.terminal.write.mutate({ sessionId: slowFlood.sessionId, data: "g" })
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  expect(viewer.received.length).toBe(receivedWhileShown)
  viewer.stream.setVisible(true)
  // About 8 KiB while hidden: a replay of at most 16 KiB.
  await waitFor(() => viewer.stream.starts.length === 2, 5_000, "the start after showing")
  expect(viewer.stream.starts).toEqual(["snapshot", "replay"])
  await control.trpc.terminal.write.mutate({ sessionId: slowFlood.sessionId, data: "q" })
  await expectSameBuffer(viewer, slowFlood.sessionId)

  const bigFlood = await spawnFlood(control, "lines", 2048 * KiB)
  const bigViewer = new Viewer(await newClient(), bigFlood.sessionId, "keep")
  await waitFor(() => bigViewer.screen().includes("R"), 15_000, "start")
  bigViewer.stream.setVisible(false)
  await control.trpc.terminal.write.mutate({ sessionId: bigFlood.sessionId, data: "g" })
  await waitFor(() => bigFlood.produced() > 1024 * KiB, 10_000, "1 MiB while hidden")
  // Log lines scrolled into history meanwhile, so no refresh: a snapshot.
  bigViewer.stream.setVisible(true)
  await waitFor(() => bigViewer.stream.starts.length === 2, 5_000, "the start after showing")
  expect(bigViewer.stream.starts).toEqual(["snapshot", "snapshot"])
  await control.trpc.terminal.write.mutate({ sessionId: bigFlood.sessionId, data: "q" })
  await expectSameBuffer(bigViewer, bigFlood.sessionId)
  for (const flood of [slowFlood, bigFlood])
    await control.trpc.terminal.kill.mutate({ sessionId: flood.sessionId })
}, 60_000)

test("while the user has a selection or has scrolled up, a skip is held; it applies once released", async () => {
  const control = await newClient()
  const flood = await spawnFlood(control, "lines", 4096 * KiB)
  const viewer = new Viewer(await newClient(), flood.sessionId, "keep")
  await waitFor(() => viewer.screen().includes("R"), 15_000, "start")
  viewer.stream.setHoldSkip(true)
  viewer.hold()
  await control.trpc.terminal.write.mutate({ sessionId: flood.sessionId, data: "g" })
  const streamId = viewer.streamIds[0] as string
  await waitFor(async () => (await streamStats(streamId)).skips >= 1, 15_000, "a skip")
  viewer.release()
  // The held skip: the view keeps what it had, nothing new replaces it.
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  const heldAt = viewer.received.length
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(viewer.received.length).toBe(heldAt)
  expect(viewer.stream.starts).toEqual(["snapshot"])
  expect((await streamStats(streamId)).skipPending).toBe(true)

  viewer.stream.setHoldSkip(false)
  await waitFor(() => viewer.stream.starts.length === 2, 5_000, "the skip after release")
  expect(viewer.stream.starts).toEqual(["snapshot", "snapshot"])
  await control.trpc.terminal.write.mutate({ sessionId: flood.sessionId, data: "q" })
  await expectSameBuffer(viewer, flood.sessionId)
  await control.trpc.terminal.kill.mutate({ sessionId: flood.sessionId })
}, 60_000)

test("adaptive cap: on a slow link the connection cap shrinks to about 1 s of drain, and heartbeats do not time out", async () => {
  const control = await newClient()
  const flood = await spawnFlood(control, "lines", 1024 * KiB)
  // 48 KB/s: the full 256 KiB cap would take over 5 s, past the 3 s pong timeout.
  const phone = await newClientVia(await slowLink(48_000, 35))
  const viewer = new Viewer(phone, flood.sessionId, "keep")
  await waitFor(() => viewer.screen().includes("R"), 15_000, "start")
  const socketsBefore = phone.sockets.length
  const statesBefore = phone.states.length
  await control.trpc.terminal.write.mutate({ sessionId: flood.sessionId, data: "g" })
  await new Promise((resolve) => setTimeout(resolve, 12_000))
  const stats = await streamStats(viewer.streamIds[0] as string)
  expect(stats.connection.output.capBytes).toBeLessThanOrEqual(96 * KiB)
  expect(stats.connection.output.capBytes).toBeGreaterThanOrEqual(32 * KiB)
  expect(phone.states.slice(statesBefore)).not.toContain("reconnecting")
  expect(phone.sockets.length).toBe(socketsBefore)
  await control.trpc.terminal.write.mutate({ sessionId: flood.sessionId, data: "q" })
  await expectSameBuffer(viewer, flood.sessionId)
  await control.trpc.terminal.kill.mutate({ sessionId: flood.sessionId })
}, 60_000)

test("acks for an ended stream are ignored", async () => {
  const control = await newClient()
  const flood = await spawnFlood(control, "lines", 256 * KiB)
  const client = await newClient()
  const ended = new Viewer(client, flood.sessionId, "keep")
  const live = new Viewer(client, flood.sessionId, "keep")
  await waitFor(() => ended.screen().includes("R") && live.screen().includes("R"), 15_000, "start")
  const endedId = ended.streamIds[0] as string
  ended.stream.close()
  await waitFor(
    async () =>
      (await connectionStats()).every((entry) =>
        entry.output.streams.every((stream) => stream.streamId !== endedId),
      ),
    5_000,
    "the stream to end",
  )
  expect(
    await client.trpc.terminal.ack.mutate({ streamId: endedId, offset: 1e12, holdSkip: false }),
  ).toEqual({ ok: true, known: false })
  await control.trpc.terminal.write.mutate({ sessionId: flood.sessionId, data: "g" })
  await new Promise((resolve) => setTimeout(resolve, 500))
  await control.trpc.terminal.write.mutate({ sessionId: flood.sessionId, data: "q" })
  await expectSameBuffer(live, flood.sessionId)
  await control.trpc.terminal.kill.mutate({ sessionId: flood.sessionId })
}, 30_000)
