// Integration test for the terminal router via `createCallerFactory` — no
// Electron window. The test owns an in-process `DaemonServer` on
// a temp socket and a `DaemonClient` connected to it, injected as the router's
// context. This exercises the real router → real daemon client → real PTY path;
// only the *transport* (caller vs IPC) and the daemon's *home* (in-process vs
// detached child) are substituted, both of which the app/verify harness covers.

import { readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import type { Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PiLabDatabase } from "@pi-lab/local-db"
import { DaemonClient, DaemonServer } from "@pi-lab/pty-daemon"
import type { Unsubscribable } from "@trpc/server/observable"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { NotebookServers } from "../../notebooks/notebookServers"
import { createNotificationBrokers, NotificationService } from "../../notifications"
import { appRouter } from "../appRouter"
import { type AppContext, DEFAULT_AGENT_CATALOG } from "../context"
import { inProcessAnalysisPreview } from "../science/analysis/previewWorker"
import { createCallerFactory } from "../trpc"
import type { TerminalEvent } from "./terminal"

const NODE = process.execPath
const createCaller = createCallerFactory(appRouter)

let socketDir: string
let socketPath: string
let server: DaemonServer
let client: DaemonClient
let caller: ReturnType<typeof createCaller>
let callerContext: AppContext
let terminalActivityCount: number
/** What the router told the activity monitor the user typed (sessionId, data). */
let userInputs: Array<[string, string]>
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
  userInputs = []
  // The terminal router never reads `db`, `sshExec`, or `httpFetch`; stubs keep
  // the context typed without standing up SQLite (or ssh / network) for a
  // pure-PTY test.
  callerContext = {
    thumbnailImageProcessor: { inspect: () => null, inspectWebP: async () => null },
    db: {} as PiLabDatabase,
    skillsHomeDir: socketDir,
    userDataDir: socketDir,
    getDaemonClient: async () => client,
    agentCatalog: DEFAULT_AGENT_CATALOG,
    resolveAgentExecutable: async (candidate) => candidate,
    getAgentLaunchEnvironment: async () => ({ ...process.env }) as Record<string, string>,
    runNonInteractiveProcess: async () => {
      throw new Error("runNonInteractiveProcess unused in terminal tests")
    },
    credentialCipher: { encrypt: (value) => value, decrypt: (value) => value },
    sshExec: async () => ({ ok: true, detail: "stub" }),
    httpFetch: async () => {
      throw new Error("httpFetch unused in terminal tests")
    },
    openPath: async () => "",
    revealPath: () => {},
    trashPath: async () => {},
    writeClipboard: () => {},
    pyToolsExec: async () => ({ stdout: "", stderr: "", code: null, notFound: true }),
    discoverPythonEnvironments: async () => [],
    resolvePythonRuntime: async () => ({
      source: null,
      displayName: "No virtual env",
      interpreterPath: process.execPath,
      runStrategy: { kind: "python", command: process.execPath, argsPrefix: [] },
    }),
    analysisPreview: inProcessAnalysisPreview,
    analysisInteractive: {
      begin: async () => 1,
      openReport: async () => ({ type: "html", url: "pi-lab-report://unused/" }),
      startMarimo: async () => ({ type: "marimo", url: "http://127.0.0.1/" }),
      close: async () => {},
      dispose: () => {},
    },
    notebookServers: new NotebookServers(
      { start: 42_800, end: 42_899 },
      10_000,
      null,
      async () => {},
    ),
    notifications,
    activityStatus: { subscribe: () => () => {}, projectsChanged: () => {} },
    activityMonitor: {
      track: async () => {},
      trackTerminal: async () => {},
      reconcile: async () => {},
      liveAgentCount: () => 0,
      liveAgents: () => [],
      userInput: (sessionId, data) => {
        userInputs.push([sessionId, data])
      },
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
  }
  caller = createCaller(callerContext)
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
  test("a reset on the real socket rejects pending RPCs and errors the active stream when it cannot attach again", async () => {
    const session = await client.spawn({ command: "cat", args: [] })
    const errors: Error[] = []
    const stream = await caller.terminal.onData({ sessionId: session.id })
    subscriptions.push(stream.subscribe({ error: (error) => errors.push(error) }))
    await client.list()
    const pending = expect(client.list()).rejects.toThrow("daemon connection closed")
    const socket = (client as unknown as { socket: Socket }).socket
    // Fault injection on the connected transport, exercising net.Socket's actual error/close path.
    socket.destroy(Object.assign(new Error("connection reset"), { code: "ECONNRESET" }))
    await pending
    await waitFor(() => errors.length === 1)
    expect(errors[0]?.message).toBe(
      "daemon connection closed, and attaching again failed: client is not connected",
    )
  })

  test("reports connection closure instead of leaving the terminal stream pending when it cannot attach again", async () => {
    const session = await client.spawn({ command: "cat", args: [] })
    const errors: Error[] = []
    const stream = await caller.terminal.onData({ sessionId: session.id })
    subscriptions.push(stream.subscribe({ error: (error) => errors.push(error) }))
    // A round trip proves the subscription's preceding attach has been processed.
    await client.list()
    client.close()
    await waitFor(() => errors.length === 1)
    expect(errors[0]?.message).toBe(
      "daemon connection closed, and attaching again failed: client is not connected",
    )
  })

  test("a subscriber after process exit receives the screen before exit", async () => {
    const { sessionId } = await caller.terminal.spawn({
      command: NODE,
      args: ["-e", "process.stdout.write('FINAL-REPLAY')"],
      cols: 80,
      rows: 24,
    })
    const deadline = Date.now() + 4000
    while ((await client.list()).find((session) => session.id === sessionId)?.alive) {
      if (Date.now() > deadline) throw new Error("process did not exit")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const events: TerminalEvent[] = []
    const stream = await caller.terminal.onData({ sessionId })
    subscriptions.push(stream.subscribe({ next: (event) => events.push(event) }))
    await waitFor(() => events.some((event) => event.type === "exit"))
    expect(events).toEqual([
      // The screen snapshot ends with the cursor position.
      { type: "data", chunk: expect.stringContaining("FINAL-REPLAY") },
      expect.objectContaining({ type: "exit", exitCode: 0 }),
    ])
  })

  test("closing one subscriber keeps another subscriber to the same session live", async () => {
    const session = await client.spawn({ command: "cat", args: [] })
    const first = await collect(session.id)
    const firstSubscription = subscriptions[subscriptions.length - 1]
    const second = await collect(session.id)
    await client.write(session.id, "BEFORE-CLOSE\n")
    await waitFor(() => first.chunks.join("").includes("BEFORE-CLOSE"))
    await waitFor(() => second.chunks.join("").includes("BEFORE-CLOSE"))
    firstSubscription?.unsubscribe()
    await client.write(session.id, "AFTER-CLOSE\n")
    await waitFor(() => second.chunks.join("").includes("AFTER-CLOSE"))
  })

  test("onData reports daemon acquisition failure to its observer", async () => {
    caller = createCaller({
      ...callerContext,
      getDaemonClient: async () => {
        throw new Error("daemon unavailable")
      },
    })
    const errors: Error[] = []
    const stream = await caller.terminal.onData({ sessionId: "missing-session" })
    subscriptions.push(stream.subscribe({ error: (error: Error) => errors.push(error) }))

    await waitFor(() => errors.length > 0, 1000)
    expect(errors[0]?.message).toContain("daemon unavailable")
  })

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

  /** Spawn a program that prints `output` and stays alive, and wait until its output ends in END. */
  async function printAndWait(output: string, cols: number, rows: number): Promise<string> {
    const { sessionId } = await caller.terminal.spawn({
      command: NODE,
      args: ["-e", `process.stdout.write(${JSON.stringify(output)}); setInterval(() => {}, 1000)`],
      cols,
      rows,
    })
    const { chunks } = await collect(sessionId)
    await waitFor(() => chunks.join("").endsWith("END"))
    return sessionId
  }

  test("screenText returns the visible screen as plain text, without colours or trailing spaces", async () => {
    const sessionId = await printAndWait(
      "\x1b[31mred\x1b[0m text   \r\n\x1b[4;3H\x1b[1;42mmoved\x1b[0m END",
      40,
      8,
    )
    expect(await caller.terminal.screenText({ sessionId })).toEqual({
      text: "red text\n\n\n  moved END",
      cols: 40,
      rows: 8,
    })
    await caller.terminal.kill({ sessionId })
  })

  test("screenText leaves out the scroll back and shows an alternate screen app as it is", async () => {
    const lines = Array.from({ length: 8 }, (_, index) => `line ${index + 1}\r\n`).join("")
    const scrolled = await printAndWait(`${lines}END`, 20, 5)
    expect((await caller.terminal.screenText({ sessionId: scrolled })).text).toBe(
      "line 5\nline 6\nline 7\nline 8\nEND",
    )
    await caller.terminal.kill({ sessionId: scrolled })

    const app = await printAndWait(
      "shell prompt\r\n\x1b[?1049h\x1b[H\x1b[2J\x1b[7mtop bar\x1b[0m\x1b[3;5Hstatus END",
      30,
      6,
    )
    expect((await caller.terminal.screenText({ sessionId: app })).text).toBe(
      "top bar\n\n    status END",
    )
    await caller.terminal.kill({ sessionId: app })
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
    await caller.terminal.resize({ sessionId, cols: 120, rows: 40, clientId: "test-client" })
    await caller.terminal.write({ sessionId, data: "\n" })
    await waitFor(() => /SIZE 120x40/.test(chunks.join("")))
    expect(chunks.join("")).toMatch(/SIZE 120x40/)

    await caller.terminal.kill({ sessionId })
  })
})

/**
 * Stand-in for an agent's menu (not a real agent): a program that draws a
 * screen captured from a real Claude Code menu and logs every key it reads,
 * one JSON string per line, to `keysFile`. The screen stays as drawn.
 */
async function menuStandIn(fixture: string): Promise<{ sessionId: string; keys: () => string[] }> {
  const screen = readFileSync(
    new URL(`../../activity/__fixtures__/menus/${fixture}.txt`, import.meta.url),
    "utf8",
  )
  const keysFile = join(socketDir, `keys-${fixture}.log`)
  await writeFile(keysFile, "")
  const script = [
    "const fs = require('node:fs')",
    "process.stdin.setRawMode(true)",
    `process.stdin.on('data', (data) => fs.appendFileSync(${JSON.stringify(keysFile)}, JSON.stringify(data.toString()) + '\\n'))`,
    `process.stdout.write(${JSON.stringify(screen.trimEnd().replaceAll("\n", "\r\n"))})`,
  ].join(";")
  const { sessionId } = await caller.terminal.spawn({
    command: NODE,
    args: ["-e", script],
    cols: 80,
    rows: 30,
  })
  const { chunks } = await collect(sessionId)
  const lastLine = screen.trimEnd().split("\n").at(-1) ?? ""
  await waitFor(() => chunks.join("").includes(lastLine))
  return {
    sessionId,
    keys: () =>
      readFileSync(keysFile, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as string),
  }
}

describe("terminal menus (stand-in agent drawing captured Claude Code screens)", () => {
  test("screenText returns the menu on the screen; a choice sends its key once and ends the menu", async () => {
    const { sessionId, keys } = await menuStandIn("claude-single-choice")
    const screen = await caller.terminal.screenText({ sessionId })
    expect(screen.menu?.question).toBe("Which colour do you prefer?")
    expect(screen.menu?.options.map((option) => option.key)).toEqual(["1", "2", "3", "4", "5", "6"])
    const menuId = screen.menu?.id ?? ""

    const choose = () =>
      caller.terminal.chooseOption({
        sessionId,
        messageId: "choice-1",
        clientId: "phone",
        menuId,
        action: { kind: "choose", option: "3" },
      })
    expect(await choose()).toEqual({ status: "sent", finished: true })
    // A resend after a lost reply writes nothing.
    expect(await choose()).toEqual({ status: "duplicate" })
    await waitFor(() => keys().length > 0)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(keys()).toEqual(["3"])
    // The agent moves on, as after an answer sent with Enter: the waiting request clears.
    expect(userInputs).toEqual([[sessionId, "\r"]])
    await caller.terminal.kill({ sessionId })
  })

  test("a choice for a menu that is no longer on screen writes nothing", async () => {
    const { sessionId, keys } = await menuStandIn("claude-single-choice")
    expect(
      await caller.terminal.chooseOption({
        sessionId,
        messageId: "choice-stale",
        clientId: "phone",
        menuId: "a-menu-seen-earlier",
        action: { kind: "choose", option: "1" },
      }),
    ).toEqual({ status: "menu-changed" })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(keys()).toEqual([])
    expect(userInputs).toEqual([])
    await caller.terminal.kill({ sessionId })
  })

  test("the trust prompt gets arrow keys, then Enter, one write each", async () => {
    const { sessionId, keys } = await menuStandIn("claude-trust")
    const menuId = (await caller.terminal.screenText({ sessionId })).menu?.id ?? ""
    expect(
      await caller.terminal.chooseOption({
        sessionId,
        messageId: "trust-yes",
        clientId: "phone",
        menuId,
        action: { kind: "choose", option: "2" },
      }),
    ).toEqual({ status: "sent", finished: true })
    await waitFor(() => keys().length === 2)
    expect(keys()).toEqual(["\u001b[B", "\r"])
    await caller.terminal.kill({ sessionId })
  })

  test("a client id longer than 200 characters is refused before anything is written", async () => {
    const { sessionId, keys } = await menuStandIn("claude-single-choice")
    const menuId = (await caller.terminal.screenText({ sessionId })).menu?.id ?? ""
    await expect(
      caller.terminal.chooseOption({
        sessionId,
        messageId: "long-client",
        clientId: "x".repeat(201),
        menuId,
        action: { kind: "choose", option: "1" },
      }),
    ).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(keys()).toEqual([])
    await caller.terminal.kill({ sessionId })
  })

  test("ticking a multi-select option does not end the menu", async () => {
    const { sessionId, keys } = await menuStandIn("claude-multi-select")
    const menuId = (await caller.terminal.screenText({ sessionId })).menu?.id ?? ""
    expect(
      await caller.terminal.chooseOption({
        sessionId,
        messageId: "tick-2",
        clientId: "phone",
        menuId,
        action: { kind: "choose", option: "2" },
      }),
    ).toEqual({ status: "sent", finished: false })
    await waitFor(() => keys().length === 1)
    expect(keys()).toEqual(["2"])
    expect(userInputs).toEqual([])
    await caller.terminal.kill({ sessionId })
  })
})
