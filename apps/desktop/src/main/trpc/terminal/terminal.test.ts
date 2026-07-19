// Integration test for the terminal router via `createCallerFactory` — no
// Electron window (md/engineering/testing-and-build.md). The test owns an in-process `DaemonServer` on
// a temp socket and a `DaemonClient` connected to it, injected as the router's
// context. This exercises the real router → real daemon client → real PTY path;
// only the *transport* (caller vs IPC) and the daemon's *home* (in-process vs
// detached child) are substituted, both of which the app/verify harness covers.

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PiLabDatabase } from "@pi-lab/local-db"
import { DaemonClient, DaemonServer } from "@pi-lab/pty-daemon"
import type { Unsubscribable } from "@trpc/server/observable"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createNotificationBrokers, NotificationService } from "../../notifications"
import { appRouter } from "../appRouter"
import { DEFAULT_AGENT_CATALOG } from "../context"
import { createCallerFactory } from "../trpc"
import type { TerminalEvent } from "./terminal"

const NODE = process.execPath
const createCaller = createCallerFactory(appRouter)

let socketDir: string
let socketPath: string
let server: DaemonServer
let client: DaemonClient
let caller: ReturnType<typeof createCaller>
let terminalActivityCount: number
const subscriptions: Unsubscribable[] = []

beforeEach(async () => {
  socketDir = await mkdtemp(join(tmpdir(), "pi-lab-term-router-"))
  socketPath = join(socketDir, "daemon.sock")
  server = new DaemonServer({ socketPath })
  await server.listen()
  client = new DaemonClient(socketPath)
  await client.connect()
  const notifications = createNotificationBrokers()
  terminalActivityCount = 0
  // The terminal router never reads `db`, `sshExec`, or `httpFetch`; stubs keep
  // the context typed without standing up SQLite (or ssh / network) for a
  // pure-PTY test.
  caller = createCaller({
    db: {} as PiLabDatabase,
    skillsHomeDir: socketDir,
    getDaemonClient: async () => client,
    agentCatalog: DEFAULT_AGENT_CATALOG,
    resolveAgentExecutable: async (candidate) => candidate,
    getAgentLaunchEnvironment: async () => ({ ...process.env }) as Record<string, string>,
    runNonInteractiveProcess: async () => {
      throw new Error("runNonInteractiveProcess unused in terminal tests")
    },
    credentialCipher: { encrypt: (value) => value },
    sshExec: async () => ({ ok: true, detail: "stub" }),
    httpFetch: async () => {
      throw new Error("httpFetch unused in terminal tests")
    },
    openPath: async () => "",
    pyToolsExec: async () => ({ stdout: "", stderr: "", code: null, notFound: true }),
    discoverPythonEnvironments: async () => [],
    resolvePythonRuntime: async () => ({
      source: null,
      displayName: "No virtual env",
      interpreterPath: process.execPath,
      runStrategy: { kind: "python", command: process.execPath, argsPrefix: [] },
    }),
    notifications,
    activityMonitor: {
      track: async () => {},
      trackTerminal: async () => {},
      reconcile: async () => {},
      liveAgentCount: () => 0,
      userInput: () => {},
      resize: () => {},
      dispose: () => {},
    },
    notificationService: new NotificationService({
      native: { isSupported: () => false, deliver: () => {} },
      focus: { isFocused: () => true, restoreAndFocus: () => {} },
      getPreferences: () => ({
        muted: false,
        agentInput: { enabled: true, sound: "chime" },
        agentTurnCompletion: { enabled: true, sound: "success" },
        terminalCompletion: { enabled: true, sound: "success" },
        workflowStart: { enabled: false, sound: "pulse" },
        workflowCompletion: { enabled: true, sound: "success" },
        workflowFailure: { enabled: true, sound: "alert" },
      }),
      activations: notifications.activations,
      sounds: notifications.sounds,
      errors: notifications.errors,
      logger: { warn: () => {} },
    }),
    caffeine: {
      status: () => ({ mode: "off", scope: "system-only", held: false }),
      configure: (settings) => ({ ...settings, held: settings.mode === "on" }),
      markTerminalActivity: () => {
        terminalActivityCount += 1
      },
      beginMeaningfulActivity: () => () => {},
    },
  })
})

afterEach(async () => {
  for (const sub of subscriptions) sub.unsubscribe()
  subscriptions.length = 0
  client.close()
  await server.close()
  await rm(socketDir, { recursive: true, force: true })
})

/** Poll a predicate until true or the deadline; deterministic, no fixed sleeps. */
async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("waitFor timed out")
}

/** Subscribe to `terminal.onData`, accumulating events for assertions. */
async function collect(sessionId: string): Promise<{
  chunks: string[]
  exits: Array<{ exitCode: number | null; signal: number | null }>
}> {
  const chunks: string[] = []
  const exits: Array<{ exitCode: number | null; signal: number | null }> = []
  const observableLike = await caller.terminal.onData({ sessionId })
  const sub = observableLike.subscribe({
    next: (event: TerminalEvent) => {
      if (event.type === "data") chunks.push(event.chunk)
      else exits.push({ exitCode: event.exitCode, signal: event.signal })
    },
  })
  subscriptions.push(sub)
  return { chunks, exits }
}

describe("terminal router", () => {
  test("spawn + onData streams a marker and a final exit", async () => {
    const { sessionId } = await caller.terminal.spawn({
      command: NODE,
      args: ["-e", "process.stdout.write('MARK-OK'); process.exit(0)"],
      cols: 80,
      rows: 24,
    })

    const { chunks, exits } = await collect(sessionId)
    await waitFor(() => chunks.join("").includes("MARK-OK") && exits.length > 0)

    expect(chunks.join("")).toContain("MARK-OK")
    expect(exits.length).toBeGreaterThan(0)
    expect(exits[0]?.exitCode).toBe(0)
  })

  test("write echoes through a long-lived cat; list shows it; kill ends it", async () => {
    const { sessionId } = await caller.terminal.spawn({
      command: "cat",
      args: [],
      cols: 80,
      rows: 24,
    })

    const { chunks, exits } = await collect(sessionId)

    // `cat` in a PTY echoes stdin back to stdout.
    await caller.terminal.write({ sessionId, data: "ECHO-ME\n" })
    await waitFor(() => chunks.join("").includes("ECHO-ME"))
    expect(chunks.join("")).toContain("ECHO-ME")
    expect(terminalActivityCount).toBeGreaterThanOrEqual(2)

    const listed = await caller.terminal.list()
    expect(listed.some((s) => s.id === sessionId && s.alive)).toBe(true)

    await caller.terminal.kill({ sessionId })
    await waitFor(() => exits.length > 0)
    expect(exits.length).toBeGreaterThan(0)
  })

  test("onData replays scrollback to a late subscriber", async () => {
    const { sessionId } = await caller.terminal.spawn({
      command: "cat",
      args: [],
      cols: 80,
      rows: 24,
    })

    // First subscriber drives output, then we add a *late* subscriber that must
    // see the prior output via scrollback replay.
    const first = await collect(sessionId)
    await caller.terminal.write({ sessionId, data: "BEFORE-REPLAY\n" })
    await waitFor(() => first.chunks.join("").includes("BEFORE-REPLAY"))

    const late = await collect(sessionId)
    await waitFor(() => late.chunks.join("").includes("BEFORE-REPLAY"))
    expect(late.chunks.join("")).toContain("BEFORE-REPLAY")

    await caller.terminal.kill({ sessionId })
  })

  test("resize updates the reported pty size", async () => {
    const { sessionId } = await caller.terminal.spawn({
      command: NODE,
      args: [
        "-e",
        "process.stdin.on('data', () => process.stdout.write('SIZE ' + process.stdout.columns + 'x' + process.stdout.rows + '\\n'))",
      ],
      cols: 80,
      rows: 24,
    })

    const { chunks } = await collect(sessionId)
    await caller.terminal.resize({ sessionId, cols: 120, rows: 40 })
    await caller.terminal.write({ sessionId, data: "\n" })
    await waitFor(() => /SIZE 120x40/.test(chunks.join("")))
    expect(chunks.join("")).toMatch(/SIZE 120x40/)

    await caller.terminal.kill({ sessionId })
  })
})
