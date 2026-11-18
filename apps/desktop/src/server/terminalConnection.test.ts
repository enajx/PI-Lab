// Terminal output, resume and connection done checks (md/plans/multi-machine-step1.md),
// run against the real PI Lab server: ServerRuntime, the loopback HTTP and
// WebSocket listener, the real routers, a real PTY daemon (in-process
// DaemonServer, adopted by the runtime's supervisor) and real PTYs. Each viewer
// is a Node client built from the same client code as the desktop renderer
// (renderer/trpc/serverLinks.ts and renderer/Terminal/terminalStream.ts) with
// an @xterm/headless emulator instead of the renderer's xterm.js.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DaemonServer } from "@pi-lab/pty-daemon"
import { createTRPCClient } from "@trpc/client"
import xtermHeadless from "@xterm/headless"
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest"
import { WebSocket } from "ws"
import type { ServerRouter } from "../main/trpc/serverRouter"
import { OUTPUT_QUEUE_LIMIT_BYTES, TYPING_HOLDS_SIZE_MS } from "../main/trpc/terminal/terminal"
import {
  type DropPolicy,
  type ResumePoint,
  type SubscribeOutput,
  type TerminalEmulator,
  TerminalStream,
} from "../renderer/Terminal/terminalStream"
import { type ConnectionState, ConnectionStatus } from "../renderer/trpc/connectionStatus"
import { createServerSockets } from "../renderer/trpc/serverLinks"
import { ensureLocalToken } from "./access"
import { type ListeningServer, listen } from "./http"
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
const COLS = 80
const ROWS = 24

vi.mock("electron", () => {
  throw new Error("The PI Lab server loaded electron")
})

let dataDir: string
let daemon: DaemonServer
let runtime: ServerRuntime
let server: ListeningServer
let url: string
const clients: Client[] = []

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
  url = `ws://127.0.0.1:${server.port}/trpc?token=${encodeURIComponent(ensureLocalToken(dataDir))}`
})

afterEach(async () => {
  for (const client of clients) await client.close()
  clients.length = 0
})

afterAll(async () => {
  await server?.close()
  runtime?.dispose()
  await daemon?.close()
  rmSync(dataDir, { recursive: true, force: true })
})

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
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

  constructor() {
    const sockets = this.sockets
    class RecordedWebSocket extends WebSocket {
      constructor(address: string) {
        super(address)
        sockets.push(this)
      }
    }
    const created = createServerSockets<ServerRouter>({
      url: async () => url,
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
  const client = new Client()
  await client.trpc.terminal.list.query()
  return client
}

/** A terminal view: a headless emulator fed by a {@link TerminalStream}. */
class Viewer {
  readonly terminal = new HeadlessTerminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
  readonly stream: TerminalStream
  readonly subscribeInputs: (ResumePoint | null)[] = []
  /** Ids (resume points) of every event received, in order. */
  readonly receivedIds: string[] = []
  #held: (() => void)[] | null = null
  exited = false

  constructor(client: Client, sessionId: string, dropPolicy: DropPolicy) {
    const subscribe: SubscribeOutput = (input, handlers) => {
      this.subscribeInputs.push(input.resume)
      return client.trpc.terminal.output.subscribe(input, {
        ...handlers,
        onData: (event) => {
          this.receivedIds.push(event.id)
          handlers.onData(event)
        },
      })
    }
    const emulator: TerminalEmulator = {
      write: (data, applied) => {
        const run = () => this.terminal.write(data, applied)
        if (this.#held) this.#held.push(run)
        else run()
      },
      reset: () => this.terminal.reset(),
      resize: (cols, rows) => this.terminal.resize(cols, rows),
    }
    this.stream = new TerminalStream({
      subscribe,
      sessionId,
      emulator,
      dropPolicy,
      onSize: () => {},
      onExit: () => {
        this.exited = true
      },
      onError: (message) => {
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
    expect(viewer.stream.starts).toEqual(["snapshot", "replay"])
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

test("a slow reader is cut off at the queue limit, then recovers to the correct screen when it reads again", async () => {
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
  let bytesBeforeBehind = 0
  let behind = false
  socket.on("message", (data: Buffer) => {
    if (behind) return
    bytesBeforeBehind += data.length
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
  // Short of the client's heartbeat timeout, so this is the queue limit at work.
  tcp.resume()

  await waitFor(() => reference.screen().includes("FINAL"), 60_000, "the reference to finish")
  await expectSameEnd(reference, viewer)
  expect(behind).toBe(true)
  // All the server held for this connection reached it; that is the bound on its queue
  // (the limit, one event, and the kernel socket buffers).
  expect(bytesBeforeBehind).toBeLessThan(OUTPUT_QUEUE_LIMIT_BYTES + 8 * 1024 * 1024)
  expect(viewer.stream.starts.length).toBeGreaterThanOrEqual(2)
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
