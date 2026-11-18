#!/usr/bin/env node
// Flood test harness (md/plans/multi-machine-step1.md, "Done checks", Flood
// test). It measures and reports; it sets no pass limits.
//
// Every run starts the built PI Lab server (apps/desktop/out/main/server.js,
// Electron binary in Node mode, test mode, temp data folder). Clients are Node
// processes running the desktop client code unchanged
// (renderer/trpc/serverLinks.ts, renderer/Terminal/terminalStream.ts,
// renderer/trpc/connectionStatus.ts) with an @xterm/headless emulator per
// terminal, as in apps/desktop/src/server/terminalConnection.test.ts. One Node
// client process plays the renderer: all its terminal views, its quiet
// terminal and its small calls share one event loop.
//
// Scenarios (see SCENARIOS below): a loopback, b slow reader, c reconnect,
// d SSH tunnel, e Tailscale, f background Expo build, g the real Electron app
// (tests/flood/appFlood.mjs).
//
// Usage: node tests/flood/run-flood.mjs [--runs 3] [--seconds 15] [--rate MiB/s]
//          [--only a1,a4,...] [--skip-build] [--trial] [--out results.json]
// --trial: 1 run of 5 s per scenario, numbers labelled "trial".

import "./tsResolve.mjs"
import { execFile, execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { cpus, platform, release, tmpdir, totalmem } from "node:os"
import { dirname, join } from "node:path"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileP = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, "..", "..")
const DESKTOP = join(REPO, "apps", "desktop")
const SRC = join(DESKTOP, "src")
const SERVER_ENTRY = join(DESKTOP, "out", "main", "server.js")
const FLOOD_PROGRAM = join(HERE, "floodProgram.cjs")
const EXPO_APP = join(REPO, "tests", "expo-client")
const COLS = 80
const ROWS = 24
const MiB = 1024 * 1024

const { createTRPCClient } = await import("desktop:@trpc/client")
const { WebSocket } = await import("desktop:ws")
const { Terminal: HeadlessTerminal } = (await import("desktop:@xterm/headless")).default
const { createServerSockets } = await import(join(SRC, "renderer/trpc/serverLinks.ts"))
const { TerminalStream } = await import(join(SRC, "renderer/Terminal/terminalStream.ts"))
const { ConnectionStatus } = await import(join(SRC, "renderer/trpc/connectionStatus.ts"))
const { SshTunnel } = await import(join(SRC, "main/server/tunnel.ts"))
const { startSshTestServer } = await import(
  join(REPO, "tests/support/sshTestServer.ts")
)
const ELECTRON = (await import("node:module")).createRequire(join(DESKTOP, "package.json"))(
  "electron",
)

// ------------------------------------------------------------------ options

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 ? fallback : argv[index + 1]
}
const TRIAL = flag("--trial")
const RUNS = Number(option("--runs", TRIAL ? "1" : "3"))
const SECONDS = Number(option("--seconds", TRIAL ? "5" : "15"))
const RATE = Number(option("--rate", "4")) * MiB
const ONLY = option("--only", null)?.split(",") ?? null
const OUT = option(
  "--out",
  join(tmpdir(), `pi-lab-flood-${new Date().toISOString().replaceAll(":", "-")}.json`),
)
if (!(RUNS >= 1 && SECONDS >= 1 && RATE > 0)) throw new Error("bad --runs, --seconds or --rate")

// ------------------------------------------------------------------ helpers

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(10)
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
}

/** Nearest-rank percentile of numbers (null when empty). */
function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}

const round = (value, digits) =>
  value === null || value === undefined ? null : Number(value.toFixed(digits))

/** Bytes encoded in a base64 string. */
function base64Length(text) {
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0
  return (text.length / 4) * 3 - padding
}

function sourceNumber(file, pattern) {
  const match = readFileSync(join(SRC, file), "utf8").match(pattern)
  if (!match) throw new Error(`could not read ${pattern} from ${file}`)
  return match[1].replaceAll("_", "").trim()
}

/** The provisional values in force, read from the source the server bundle was built from. */
function provisionalValues() {
  return {
    outputQueueLimit: sourceNumber(
      "main/trpc/terminal/terminal.ts",
      /OUTPUT_QUEUE_LIMIT_BYTES = ([^\n]+)/,
    ),
    clientKeepAlive: sourceNumber("renderer/trpc/serverLinks.ts", /CLIENT_KEEP_ALIVE = ([^\n]+)/),
    reconnectBackoff: sourceNumber(
      "renderer/trpc/serverLinks.ts",
      /return (attemptIndex === 0[^\n]+)/,
    ),
    serverPingMs: sourceNumber("server/http.ts", /SERVER_PING_MS = ([^\n]+)/),
    serverPongWaitMs: sourceNumber("server/http.ts", /SERVER_PONG_WAIT_MS = ([^\n]+)/),
    disconnectedAfterMs: sourceNumber(
      "renderer/trpc/connectionStatus.ts",
      /DISCONNECTED_AFTER_MS = ([^\n]+)/,
    ),
    daemonTailBytes: sourceNumber(
      "../../../packages/pty-daemon/src/session.ts",
      /DEFAULT_SCROLLBACK_BYTES = ([^\n]+)/,
    ),
  }
}

function machine() {
  const sw = (key) => execFileSync("sw_vers", [`-${key}`], { encoding: "utf8" }).trim()
  return {
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    ramGiB: Math.round(totalmem() / 1024 ** 3),
    os: `${sw("productName")} ${sw("productVersion")} (${sw("buildVersion")})`,
    kernel: `${platform()} ${release()}`,
    harnessNode: process.version,
    electron: execFileSync(ELECTRON, ["--version"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
    }).trim(),
  }
}

// ----------------------------------------------------------------- server

/** Start the built server on a temp data folder; resolves once it wrote server.json. */
async function startServer() {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-lab-flood-"))
  const child = spawn(ELECTRON, [SERVER_ENTRY], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PI_LAB_TEST_MODE: "1",
      PI_LAB_CHANNEL: "alpha",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_PROFILE_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_PACKAGED: "0",
      PI_LAB_RESOURCES_DIR: join(DESKTOP, "resources"),
      PI_LAB_BUILD: createHash("sha256")
        .update(readFileSync(SERVER_ENTRY))
        .digest("hex")
        .slice(0, 16),
      PI_LAB_VERSION: "0.0.0",
      PI_LAB_SERVER_PORT: "0",
    },
  })
  const log = []
  child.stdout.on("data", (chunk) => log.push(String(chunk)))
  child.stderr.on("data", (chunk) => log.push(String(chunk)))
  const discoveryFile = join(dataDir, "server.json")
  await waitFor(
    () => {
      if (child.exitCode !== null) throw new Error(`server exited early:\n${log.join("")}`)
      return existsSync(discoveryFile)
    },
    30_000,
    "server.json",
  )
  const { port, pid } = JSON.parse(readFileSync(discoveryFile, "utf8"))
  const token = readFileSync(join(dataDir, "server-token"), "utf8").trim()
  return { dataDir, child, port, pid, token, log }
}

async function stopServer(server, control) {
  if (control) {
    await control.trpc.server.stop
      .mutate({ stopAgents: true })
      .catch((error) => console.error("server.stop:", error.message))
  }
  const alive = () => {
    try {
      process.kill(server.pid, 0)
      return true
    } catch {
      return false
    }
  }
  await waitFor(() => !alive(), 15_000, "the server to stop").catch(() => {
    console.error("server did not stop in 15 s; killing it")
    process.kill(server.pid, "SIGKILL")
  })
  // The PTY daemon is stopped by server.stop; a leftover would skew the next run.
  await sleep(300)
  rmSync(server.dataDir, { recursive: true, force: true })
}

/** The server's per-connection send-queue stats (test route, epoch ms times). */
async function connectionStats(server) {
  const response = await fetch(`http://127.0.0.1:${server.port}/test/connections`, {
    headers: { "x-pi-lab-token": server.token },
  })
  if (response.status !== 200) throw new Error(`GET /test/connections: HTTP ${response.status}`)
  return response.json()
}

/** Poll the server's connection stats every `ms`; each sample keeps the queued bytes per connection id. */
function startQueueSampler(server, ms) {
  const samples = []
  let stopped = false
  const loop = (async () => {
    while (!stopped) {
      const at = Date.now()
      const stats = await connectionStats(server)
      samples.push({ t: at, queued: Object.fromEntries(stats.map((entry) => [entry.id, entry.queuedBytes])) })
      await sleep(Math.max(0, ms - (Date.now() - at)))
    }
  })()
  return {
    samples,
    stop: async () => {
      stopped = true
      await loop
    },
  }
}

async function dropConnections(server) {
  const response = await fetch(`http://127.0.0.1:${server.port}/test/drop-connections`, {
    method: "POST",
    headers: { "x-pi-lab-token": server.token },
  })
  if (response.status !== 204) throw new Error(`drop-connections: HTTP ${response.status}`)
}

// ----------------------------------------------------------------- clients

/**
 * One client device: the renderer's two sockets (serverLinks.ts) and its
 * connection status, over `ws`. `url` is read on every connection attempt;
 * `holdReconnect(ms)` makes the next attempts wait (a longer outage).
 */
class Client {
  constructor(baseUrl) {
    this.status = new ConnectionStatus()
    this.states = []
    this.sockets = []
    this.hold = null
    const sockets = this.sockets
    class RecordedWebSocket extends WebSocket {
      constructor(address, protocols) {
        super(address, protocols)
        sockets.push(this)
      }
    }
    const created = createServerSockets({
      url: async () => {
        if (this.hold) await this.hold
        return baseUrl()
      },
      WebSocket: RecordedWebSocket,
      status: this.status,
    })
    this.status.subscribe(() => this.states.push({ at: performance.now(), state: this.status.state() }))
    this.trpc = createTRPCClient({ links: [created.link] })
    this.close = created.close
  }

  holdReconnect(ms) {
    this.hold = sleep(ms).then(() => {
      this.hold = null
    })
  }

  /** The newest WebSocket of the terminal link (the calls socket is opened first). */
  terminalSocket() {
    const found = this.sockets.slice(1).at(-1)
    if (!found) throw new Error("no terminal socket yet")
    return found
  }
}

async function newClient(baseUrl) {
  const client = new Client(baseUrl)
  await client.trpc.server.hello.query()
  return client
}

/** A terminal view: an @xterm/headless emulator fed by the renderer's TerminalStream. */
class Viewer {
  constructor(client, sessionId, dropPolicy) {
    this.sessionId = sessionId
    this.terminal = new HeadlessTerminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
    this.receivedEnd = 0
    this.behindAt = []
    this.subscribeAt = []
    /** Called with every applied write's data. */
    this.onApplied = []
    this.errors = []
    const subscribe = (input, handlers) => {
      this.subscribeAt.push({ at: performance.now(), resume: input.resume })
      return client.trpc.terminal.output.subscribe(input, {
        ...handlers,
        onData: (event) => {
          const data = event.data
          if (data.type === "data" || data.type === "start")
            this.receivedEnd = data.offset + base64Length(data.base64)
          if (data.type === "behind") this.behindAt.push(performance.now())
          handlers.onData(event)
        },
      })
    }
    this.stream = new TerminalStream({
      subscribe,
      sessionId,
      emulator: {
        write: (data, applied) =>
          this.terminal.write(data, () => {
            applied()
            for (const listener of this.onApplied) listener(data)
          }),
        reset: () => this.terminal.reset(),
        resize: (cols, rows) => this.terminal.resize(cols, rows),
      },
      dropPolicy,
      onSize: () => {},
      onExit: () => {},
      onError: (message) => this.errors.push(message),
    })
    this.stream.open()
  }

  consumed() {
    return this.stream.consumed()?.offset ?? 0
  }

  screen() {
    const buffer = this.terminal.buffer.active
    const lines = []
    for (let row = 0; row < this.terminal.rows; row++)
      lines.push(buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "")
    return lines.join("\n")
  }

  /** Size, active buffer, cursor and visible text. */
  state() {
    const buffer = this.terminal.buffer.active
    return JSON.stringify({
      size: [this.terminal.cols, this.terminal.rows],
      buffer: buffer.type,
      cursor: [buffer.cursorX, buffer.cursorY],
      text: this.screen(),
    })
  }
}

/**
 * After the floods were told to stop: wait until every viewer shows FINAL and
 * its applied offset has not moved for 500 ms, then compare each viewer with a
 * fresh viewer on a new connection (a snapshot of the server's screen at its
 * end offset). `allBytesApplied`: same end offset as the server for every
 * viewer; `screensEqual`: same size, buffer, cursor and visible text.
 */
async function settle(server, viewers) {
  const started = performance.now()
  let last = viewers.map((viewer) => viewer.consumed())
  let stableSince = performance.now()
  let timedOut = null
  await waitFor(
    () => {
      const now = viewers.map((viewer) => viewer.consumed())
      if (now.some((value, index) => value !== last[index])) {
        last = now
        stableSince = performance.now()
      }
      return viewers.every((viewer) => viewer.screen().includes("FINAL") && viewer.stream.queued() === 0) && performance.now() - stableSince > 500
    },
    60_000,
    "every viewer to show FINAL and stop changing",
  ).catch((error) => {
    timedOut = error.message
    console.error(error.message)
  })
  const settleMs = performance.now() - started - 500
  const fresh = await newClient(loopbackUrl(server))
  const reference = viewers.map((viewer) => new Viewer(fresh, viewer.sessionId, "keep"))
  await waitFor(() => reference.every((viewer) => viewer.screen().includes("FINAL")), 15_000, "the fresh viewers")
  const offsets = viewers.map((viewer, index) => ({ viewer: viewer.consumed(), server: reference[index].consumed() }))
  const sameOffset = offsets.filter((entry) => entry.viewer === entry.server).length
  const sameScreen = viewers.filter((viewer, index) => viewer.state() === reference[index].state()).length
  for (const viewer of reference) viewer.stream.close()
  await fresh.close()
  return {
    settleMs,
    timedOut,
    allBytesApplied: timedOut === null && sameOffset === viewers.length,
    screensEqual: `${sameScreen}/${viewers.length}`,
    offsets,
  }
}

/** Spawn the flood program in a real PTY on the server; returns its session and counter file. */
async function spawnFlood(client, server, mode, rate, index) {
  const counterFile = join(server.dataDir, `flood-${index}.count`)
  const { sessionId } = await client.trpc.terminal.spawn.mutate({
    command: process.execPath,
    args: [FLOOD_PROGRAM, mode, String(rate), counterFile],
    cols: COLS,
    rows: ROWS,
  })
  let last = 1
  return {
    sessionId,
    counterFile,
    /** PTY bytes the program has produced (read from its counter file). */
    produced: () => {
      if (!existsSync(counterFile)) return last
      const value = Number(readFileSync(counterFile, "utf8"))
      if (Number.isFinite(value) && value >= last) last = value
      return last
    },
  }
}

// ---------------------------------------------------------------- samplers

/** Parse `ps` cputime ("[[hh:]mm:]ss.cc") to seconds. */
function cpuSeconds(text) {
  return text
    .split(":")
    .map(Number)
    .reduce((sum, part) => sum * 60 + part, 0)
}

/**
 * Sample CPU % (from cputime differences) and RSS of named process trees every
 * 500 ms. `roots()` returns { name: pid } (pids may come and go). Processes in
 * the server tree are split into server, daemon and programs (the PTY programs).
 */
function startProcessSampler(roots) {
  const samples = []
  let previous = null
  let stopped = false
  const loop = (async () => {
    while (!stopped) {
      const at = performance.now()
      const { stdout } = await execFileP("ps", ["-A", "-o", "pid=,ppid=,time=,rss=,command="], {
        maxBuffer: 16 * MiB,
      })
      const procs = new Map()
      for (const line of stdout.split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/)
        if (!match) continue
        procs.set(Number(match[1]), {
          ppid: Number(match[2]),
          cpu: cpuSeconds(match[3]),
          rssKiB: Number(match[4]),
          command: match[5],
        })
      }
      const children = new Map()
      for (const [pid, proc] of procs) {
        if (!children.has(proc.ppid)) children.set(proc.ppid, [])
        children.get(proc.ppid).push(pid)
      }
      const groups = {}
      for (const [name, rootPid] of Object.entries(roots())) {
        if (!rootPid || !procs.has(rootPid)) continue
        const stack = [rootPid]
        while (stack.length > 0) {
          const pid = stack.pop()
          const proc = procs.get(pid)
          let group = name
          if (name === "server" && pid !== rootPid)
            group = /pty-daemon|daemon/i.test(proc.command) && !proc.command.includes(FLOOD_PROGRAM)
              ? "daemon"
              : "programs"
          groups[group] ??= { pids: {}, rssKiB: 0 }
          groups[group].pids[pid] = proc.cpu
          groups[group].rssKiB += proc.rssKiB
          // The harness itself is the client; its children (server, sshd, builds) are sampled on their own.
          if (name !== "client") for (const child of children.get(pid) ?? []) stack.push(child)
        }
      }
      const sample = { t: at, groups: {} }
      for (const [group, value] of Object.entries(groups)) {
        let cpuPercent = null
        const before = previous?.groups[group]
        if (before) {
          let delta = 0
          for (const [pid, cpu] of Object.entries(value.pids))
            if (before.pids[pid] !== undefined) delta += cpu - before.pids[pid]
          cpuPercent = (delta / ((at - previous.t) / 1000)) * 100
        }
        sample.groups[group] = { rssMiB: value.rssKiB / 1024, cpuPercent, pids: value.pids }
      }
      if (previous) samples.push(sample)
      previous = sample
      await sleep(Math.max(0, 500 - (performance.now() - at)))
    }
  })()
  return {
    samples,
    stop: async () => {
      stopped = true
      await loop
    },
  }
}

function summarizeProcesses(samples, from, to) {
  const inWindow = samples.filter((sample) => sample.t >= from && sample.t <= to)
  const out = {}
  const names = new Set(inWindow.flatMap((sample) => Object.keys(sample.groups)))
  for (const name of names) {
    const values = inWindow.map((sample) => sample.groups[name]).filter(Boolean)
    const cpu = values.map((value) => value.cpuPercent).filter((value) => value !== null)
    const rss = values.map((value) => value.rssMiB)
    out[`${name}CpuMeanPct`] = round(cpu.reduce((a, b) => a + b, 0) / (cpu.length || 1), 1)
    out[`${name}CpuMaxPct`] = round(Math.max(...cpu), 1)
    out[`${name}RssMaxMiB`] = round(Math.max(...rss), 1)
    out[`${name}RssEndMiB`] = round(rss.at(-1), 1)
  }
  return out
}

/** Small calls every 100 ms, alternating server.hello and projects.list, not waiting for replies. */
function startCalls(client) {
  const samples = []
  const errors = []
  const pending = new Set()
  let index = 0
  const timer = setInterval(() => {
    const name = index++ % 2 === 0 ? "server.hello" : "projects.list"
    const started = performance.now()
    const call =
      name === "server.hello"
        ? client.trpc.server.hello.query()
        : client.trpc.projects.list.query()
    const tracked = call.then(
      () => samples.push({ t: started, name, ms: performance.now() - started }),
      (error) => errors.push(`${name}: ${error.message}`),
    )
    pending.add(tracked)
    tracked.finally(() => pending.delete(tracked))
  }, 100)
  return {
    samples,
    errors,
    stop: async () => {
      clearInterval(timer)
      await Promise.race([Promise.all(pending), sleep(10_000)])
      if (pending.size > 0) errors.push(`${pending.size} calls without a reply 10 s after the end`)
    },
  }
}

/**
 * Keystroke to echo in the quiet terminal: write one letter with
 * terminal.write (the calls socket, as the renderer does), time until the echo
 * is applied in the quiet viewer's emulator. One key at a time, 200 ms apart.
 */
function startEcho(client, viewer, sessionId) {
  const samples = []
  const timeouts = []
  let stopped = false
  const loop = (async () => {
    let index = 0
    while (!stopped) {
      const letter = "abcdefghijklmnopqrstuvwxyz"[index++ % 26]
      const code = letter.charCodeAt(0)
      const started = performance.now()
      let listener
      const echoed = new Promise((resolve) => {
        listener = (data) => {
          if (typeof data === "string" ? data.includes(letter) : data.includes(code)) resolve()
        }
        viewer.onApplied.push(listener)
      })
      client.trpc.terminal.write
        .mutate({ sessionId, data: letter, clientId: "flood-harness" })
        .catch((error) => timeouts.push({ t: started, error: error.message }))
      const result = await Promise.race([echoed.then(() => "ok"), sleep(5_000).then(() => "timeout")])
      viewer.onApplied.splice(viewer.onApplied.indexOf(listener), 1)
      if (result === "ok") samples.push({ t: started, ms: performance.now() - started })
      else timeouts.push({ t: started, error: "no echo within 5 s" })
      await sleep(200)
    }
  })()
  return {
    samples,
    timeouts,
    stop: async () => {
      stopped = true
      await loop
    },
  }
}

/** Every 250 ms: per flood terminal, bytes produced, received and applied. */
function startLagSampler(floods, viewers) {
  const samples = []
  const timer = setInterval(() => {
    const t = performance.now()
    samples.push({
      t,
      terminals: floods.map((flood, index) => ({
        produced: flood.produced(),
        received: viewers[index].receivedEnd,
        consumed: viewers[index].consumed(),
      })),
    })
  }, 250)
  return { samples, stop: () => clearInterval(timer) }
}

function latencySummary(prefix, values) {
  return {
    [`${prefix}N`]: values.length,
    [`${prefix}P50Ms`]: round(percentile(values, 50), 1),
    [`${prefix}P95Ms`]: round(percentile(values, 95), 1),
    [`${prefix}P99Ms`]: round(percentile(values, 99), 1),
    [`${prefix}MaxMs`]: round(values.length ? Math.max(...values) : null, 1),
  }
}

// ----------------------------------------------------- the common flood run

/**
 * One flood measurement: N flooding terminals and a quiet echo terminal, all
 * viewed by one client, plus small calls from that client. Returns the run's
 * summary and raw samples. `extraRoots` adds process trees to sample.
 */
async function floodRun({ server, baseUrl, terminals, mode, rate, seconds, extraRoots }) {
  const control = await newClient(() => `ws://127.0.0.1:${server.port}/trpc?token=${encodeURIComponent(server.token)}`)
  const app = await newClient(baseUrl)
  const floods = []
  for (let index = 0; index < terminals; index++)
    floods.push(await spawnFlood(control, server, mode, rate, index))
  const quiet = await spawnFlood(control, server, "echo", 0, "quiet")
  const viewers = floods.map((flood) => new Viewer(app, flood.sessionId, "keep"))
  const quietViewer = new Viewer(app, quiet.sessionId, "keep")
  for (const viewer of [...viewers, quietViewer])
    await waitFor(() => viewer.screen().includes("R"), 15_000, "the programs to start")

  const processes = startProcessSampler(() => ({ server: server.pid, client: process.pid, ...extraRoots?.() }))
  await sleep(1_000)
  // Baseline: echo and calls before the flood.
  const baseEcho = startEcho(app, quietViewer, quiet.sessionId)
  const baseCalls = startCalls(app)
  await sleep(2_000)
  await baseEcho.stop()
  await baseCalls.stop()

  for (const flood of floods) await control.trpc.terminal.write.mutate({ sessionId: flood.sessionId, data: "g" })
  await sleep(1_000)
  const loopDelay = monitorEventLoopDelay({ resolution: 10 })
  loopDelay.enable()
  const cpuStart = process.cpuUsage()
  const windowStart = performance.now()
  const startConsumed = viewers.map((viewer) => viewer.consumed())
  const startProduced = floods.map((flood) => flood.produced())
  const lag = startLagSampler(floods, viewers)
  const queue = startQueueSampler(server, 250)
  const echo = startEcho(app, quietViewer, quiet.sessionId)
  const calls = startCalls(app)
  await sleep(seconds * 1000)
  const windowEnd = performance.now()
  const endConsumed = viewers.map((viewer) => viewer.consumed())
  const endProduced = floods.map((flood) => flood.produced())
  lag.stop()
  await queue.stop()
  loopDelay.disable()
  const cpu = process.cpuUsage(cpuStart)
  await echo.stop()
  await calls.stop()

  // Stop the floods and check every viewer applied every byte produced.
  for (const flood of floods) await control.trpc.terminal.write.mutate({ sessionId: flood.sessionId, data: "q" })
  const settled = await settle(server, viewers)
  await processes.stop()
  const stats = await connectionStats(server)

  const elapsed = (windowEnd - windowStart) / 1000
  const applied = viewers.map((_, index) => (endConsumed[index] - startConsumed[index]) / elapsed)
  const produced = floods.map((_, index) => (endProduced[index] - startProduced[index]) / elapsed)
  const sampledQueued = queue.samples.map((sample) => Math.max(0, ...Object.values(sample.queued)))
  const clientQueued = lag.samples.map((sample) => sample.terminals.reduce((sum, entry) => sum + entry.received - entry.consumed, 0))
  const starts = viewers.flatMap((viewer) => viewer.stream.starts)
  const summary = {
    ...latencySummary("callBase", baseCalls.samples.map((sample) => sample.ms)),
    ...latencySummary("call", calls.samples.map((sample) => sample.ms)),
    callErrors: calls.errors.length + baseCalls.errors.length,
    ...latencySummary("echoBase", baseEcho.samples.map((sample) => sample.ms)),
    ...latencySummary("echo", echo.samples.map((sample) => sample.ms)),
    echoTimeouts: echo.timeouts.length + baseEcho.timeouts.length,
    producedMiBpsPerTerminal: round(percentile(produced, 50) / MiB, 2),
    appliedMiBpsPerTerminalMin: round(Math.min(...applied) / MiB, 2),
    appliedMiBpsPerTerminalMedian: round(percentile(applied, 50) / MiB, 2),
    appliedMiBpsTotal: round(applied.reduce((a, b) => a + b, 0) / MiB, 2),
    serverQueuedPeakMiB: round(Math.max(0, ...stats.map((entry) => entry.peakQueuedBytes)) / MiB, 2),
    serverQueuedSampledP95MiB: round(percentile(sampledQueued, 95) / MiB, 2),
    behindSent: stats.reduce((sum, entry) => sum + entry.behindAt.length, 0),
    clientQueuedPeakMiB: round(Math.max(...clientQueued) / MiB, 2),
    behindReceived: viewers.reduce((sum, viewer) => sum + viewer.behindAt.length, 0),
    resubscribes: viewers.reduce((sum, viewer) => sum + viewer.subscribeAt.length - 1, 0),
    snapshots: starts.filter((start) => start === "snapshot").length - viewers.length,
    clientLoopDelayP99Ms: round(loopDelay.percentile(99) / 1e6, 1),
    clientLoopDelayMaxMs: round(loopDelay.max / 1e6, 1),
    clientCpuPct: round(((cpu.user + cpu.system) / 1000 / (windowEnd - windowStart)) * 100, 1),
    settleAfterStopMs: round(settled.settleMs, 0),
    allBytesApplied: settled.allBytesApplied,
    screensEqualFreshSnapshot: settled.screensEqual,
    ...summarizeProcesses(processes.samples, windowStart, windowEnd),
  }
  const errors = [...viewers, quietViewer].flatMap((viewer) => viewer.errors)
  if (errors.length > 0) summary.streamErrors = errors.length

  for (const session of [...floods, quiet])
    await control.trpc.terminal.kill.mutate({ sessionId: session.sessionId })
  for (const viewer of [...viewers, quietViewer]) viewer.stream.close()
  await app.close()
  return {
    summary,
    control,
    raw: {
      calls: calls.samples.map((sample) => [round(sample.t - windowStart, 0), sample.name, round(sample.ms, 2)]),
      callErrors: [...baseCalls.errors, ...calls.errors],
      echo: echo.samples.map((sample) => [round(sample.t - windowStart, 0), round(sample.ms, 2)]),
      echoTimeouts: [...baseEcho.timeouts, ...echo.timeouts],
      baseCalls: baseCalls.samples.map((sample) => round(sample.ms, 2)),
      baseEcho: baseEcho.samples.map((sample) => round(sample.ms, 2)),
      appliedBytesPerSecond: applied.map((value) => round(value, 0)),
      producedBytesPerSecond: produced.map((value) => round(value, 0)),
      lag: lag.samples.map((sample) => ({ t: round(sample.t - windowStart, 0), terminals: sample.terminals })),
      processes: processes.samples.map((sample) => ({
        t: round(sample.t - windowStart, 0),
        ...Object.fromEntries(Object.entries(sample.groups).map(([name, value]) => [name, { cpuPercent: round(value.cpuPercent, 1), rssMiB: round(value.rssMiB, 1) }])),
      })),
      settle: settled,
      streamErrors: errors,
      connections: stats,
      serverQueued: queue.samples.map((sample) => ({ t: sample.t - (Date.now() - performance.now()) - windowStart, queued: sample.queued })),
    },
  }
}

const loopbackUrl = (server) => () =>
  `ws://127.0.0.1:${server.port}/trpc?token=${encodeURIComponent(server.token)}`

/** Run one flood measurement on a fresh server, through `transport` (loopback when null). */
async function withServer(body) {
  const server = await startServer()
  let control = null
  try {
    const result = await body(server)
    control = result.control
    delete result.control
    // The server's own log (stdout and stderr), last 40 lines, to explain failures.
    result.raw.serverLogTail = server.log.join("").split("\n").slice(-40)
    return result
  } finally {
    control ??= await newClient(loopbackUrl(server)).catch(() => null)
    await stopServer(server, control)
    await control?.close()
  }
}

// --------------------------------------------------------------- scenarios

/** a: loopback, N flooding terminals. */
function loopback(terminals, mode) {
  return () =>
    withServer((server) =>
      floodRun({ server, baseUrl: loopbackUrl(server), terminals, mode, rate: RATE, seconds: SECONDS }),
    )
}

/** An SSH tunnel (main/server/tunnel.ts) to the server, through an sshd at `sshd`. */
async function openTunnel(sshd, server) {
  return SshTunnel.open({
    host: sshd.host,
    remotePort: server.port,
    sshPath: "/usr/bin/ssh",
    extraSshArgs: sshd.clientArgs,
    serverAliveIntervalSeconds: 5,
    serverAliveCountMax: 3,
    openTimeoutMs: 10_000,
    backoff: { initialMs: 100, maxMs: 1_000 },
    onState: () => {},
    log: (message) => console.log(`[tunnel] ${message}`),
  })
}

function sshdPid(dir, name) {
  const file = join(dir, name)
  return existsSync(file) ? Number(readFileSync(file, "utf8").trim()) : null
}

/** Byte counters of one network interface (netstat -I <name> -b), summed over its rows. */
function interfaceBytes(name) {
  const lines = execFileSync("netstat", ["-I", name, "-b"], { encoding: "utf8" }).trim().split("\n")
  const header = lines[0].split(/\s+/)
  const row = lines[1].split(/\s+/)
  // Columns shift when the address column is empty; read from the end.
  const fromEnd = (column) => Number(row[row.length - (header.length - header.indexOf(column))])
  return { in: fromEnd("Ibytes"), out: fromEnd("Obytes") }
}

/** d: SSH tunnel on loopback, N=4. */
function sshTunnelRun() {
  return async () => {
    const sshd = await startSshTestServer("127.0.0.1")
    try {
      return await withServer(async (server) => {
        const tunnel = await openTunnel(sshd, server)
        try {
          const result = await floodRun({
            server,
            baseUrl: () => `ws://127.0.0.1:${tunnel.localPort}/trpc?token=${encodeURIComponent(server.token)}`,
            terminals: 4,
            mode: "lines",
            rate: RATE,
            seconds: SECONDS,
            extraRoots: () => ({ ssh: tunnel.pid, sshd: sshdPid(sshd.dir, "sshd.pid") }),
          })
          result.summary.tunnelState = tunnel.state
          return result
        } finally {
          await tunnel.close()
        }
      })
    } finally {
      await sshd.stop()
    }
  }
}

/** The Mac's own Tailscale IPv4 address, or null. */
function tailscaleAddress() {
  try {
    return execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0] || null
  } catch {
    return null
  }
}

const JUMP_HOST = "tripper4"

/** Round trip to the jump host over Tailscale: `ping` and `tailscale ping`. */
async function tailscaleRtt(host) {
  const ip = (await execFileP("ssh", ["-G", host])).stdout.match(/^hostname (\S+)$/m)?.[1]
  const ping = await execFileP("ping", ["-c", "10", "-i", "0.2", ip]).then(
    (result) => result.stdout.match(/= ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+) ms/),
    () => null,
  )
  const tsPing = await execFileP("tailscale", ["ping", "-c", "5", host]).then(
    (result) => result.stdout.trim().split("\n").filter((line) => line.startsWith("pong")),
    (error) => [`tailscale ping failed: ${error.message.split("\n")[0]}`],
  )
  return {
    host,
    ip,
    pingMs: ping ? { min: Number(ping[1]), avg: Number(ping[2]), max: Number(ping[3]), stddev: Number(ping[4]) } : null,
    tailscalePing: tsPing,
  }
}

/**
 * e: the test sshd listens on this Mac's Tailscale address; the tunnel reaches
 * it through tripper4 as a jump hop (ProxyCommand with the user's ssh config),
 * so the bytes go Mac -> tripper4 -> Mac over Tailscale. N=4.
 */
function tailscaleRun(rate) {
  return async () => {
    const address = tailscaleAddress()
    if (!address) return { skipped: "no Tailscale IPv4 address (`tailscale ip -4` failed)" }
    const sshd = await startSshTestServer(address)
    try {
      const jump = ["-o", `ProxyCommand=ssh -o BatchMode=yes -o ConnectTimeout=10 ${JUMP_HOST} -W %h:%p`]
      const viaJump = { ...sshd, clientArgs: [...sshd.clientArgs, ...jump] }
      const probe = await execFileP("/usr/bin/ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", ...viaJump.clientArgs, address, "true"]).then(
        () => null,
        (error) => error.stderr || error.message,
      )
      if (probe !== null) return { skipped: `ssh to ${address} through ${JUMP_HOST} failed: ${probe}` }
      const rtt = await tailscaleRtt(JUMP_HOST)
      const route = execFileSync("route", ["-n", "get", address], { encoding: "utf8" }).match(/interface: (\S+)/)?.[1] ?? "utun0"
      return await withServer(async (server) => {
        const tunnel = await openTunnel(viaJump, server)
        const utunBefore = interfaceBytes(route)
        try {
          const result = await floodRun({
            server,
            baseUrl: () => `ws://127.0.0.1:${tunnel.localPort}/trpc?token=${encodeURIComponent(server.token)}`,
            terminals: 4,
            mode: "lines",
            rate,
            seconds: SECONDS,
            extraRoots: () => ({ ssh: tunnel.pid, sshd: sshdPid(sshd.dir, "sshd.pid") }),
          })
          const utunAfter = interfaceBytes(route)
          result.summary.tailscaleInterface = route
          result.summary.tailscaleInMiB = round((utunAfter.in - utunBefore.in) / MiB, 1)
          result.summary.tailscaleOutMiB = round((utunAfter.out - utunBefore.out) / MiB, 1)
          result.summary.jumpPingAvgMs = rtt.pingMs?.avg ?? null
          result.raw.rtt = rtt
          return result
        } finally {
          await tunnel.close()
        }
      })
    } finally {
      await sshd.stop()
    }
  }
}

/** f: loopback N=4 while a real Expo build (`npx expo export --platform ios`) runs, restarted until the window ends. */
function expoBuildRun() {
  return async () => {
    if (!existsSync(join(EXPO_APP, "node_modules"))) return { skipped: "tests/expo-client has no node_modules (run npm ci there)" }
    const builds = []
    let child = null
    let stopping = false
    const outDir = mkdtempSync(join(tmpdir(), "pi-lab-flood-expo-"))
    const startBuild = () => {
      const started = performance.now()
      let log = ""
      child = spawn("npx", ["expo", "export", "--platform", "ios", "--output-dir", outDir, "--clear"], {
        cwd: EXPO_APP,
        env: { ...process.env, CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      })
      child.stdout.on("data", (chunk) => (log = (log + chunk).slice(-4000)))
      child.stderr.on("data", (chunk) => (log = (log + chunk).slice(-4000)))
      child.once("exit", (code, signal) => {
        builds.push({ seconds: round((performance.now() - started) / 1000, 1), code, signal, log: code === 0 || stopping ? undefined : log })
        if (!stopping) startBuild()
      })
    }
    startBuild()
    await sleep(3_000)
    try {
      const result = await withServer((server) =>
        floodRun({
          server,
          baseUrl: loopbackUrl(server),
          terminals: 4,
          mode: "lines",
          rate: RATE,
          seconds: SECONDS,
          extraRoots: () => ({ expoBuild: child?.pid }),
        }),
      )
      const failed = builds.filter((build) => build.code !== 0)
      result.summary.expoBuildsFinished = builds.length
      result.summary.expoBuildFailures = failed.length
      result.raw.expoBuilds = builds
      if (failed.length > 0) console.error("expo export failed:", failed[0].log)
      return result
    } finally {
      stopping = true
      if (child && child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve))
        process.kill(-child.pid, "SIGTERM")
        await Promise.race([exited, sleep(5_000)])
      }
      rmSync(outDir, { recursive: true, force: true })
    }
  }
}

/**
 * b: slow reader. One normal client views N flooding terminals; a second
 * client views the same terminals and stops reading its terminal socket
 * (TCP paused) for `pauseMs`, shorter than the heartbeat timeout.
 */
function slowReaderRun(terminals, pauseMs) {
  return () =>
    withServer(async (server) => {
      const control = await newClient(loopbackUrl(server))
      const fast = await newClient(loopbackUrl(server))
      const slow = await newClient(loopbackUrl(server))
      const floods = []
      for (let index = 0; index < terminals; index++)
        floods.push(await spawnFlood(control, server, "lines", RATE, index))
      const reference = floods.map((flood) => new Viewer(fast, flood.sessionId, "keep"))
      const viewers = floods.map((flood) => new Viewer(slow, flood.sessionId, "keep"))
      for (const viewer of [...reference, ...viewers])
        await waitFor(() => viewer.screen().includes("R"), 15_000, "the programs to start")
      const processes = startProcessSampler(() => ({ server: server.pid }))
      const socket = slow.terminalSocket()
      const tcp = socket._socket
      let wireBytes = 0
      let behindFrames = 0
      let firstBehindAt = null
      socket.on("message", (data) => {
        wireBytes += data.length
        if (data.includes('"type":"behind"')) {
          behindFrames += 1
          firstBehindAt ??= performance.now()
        }
      })
      for (const flood of floods) await control.trpc.terminal.write.mutate({ sessionId: flood.sessionId, data: "g" })
      await sleep(1_000)
      const t0 = performance.now()
      const queue = startQueueSampler(server, 100)
      const pausedAtEpoch = Date.now()
      tcp.pause()
      await sleep(pauseMs)
      const resumeAt = performance.now()
      const target = reference.map((viewer) => viewer.consumed())
      const wireAtResume = wireBytes
      tcp.resume()
      await waitFor(() => viewers.every((viewer, index) => viewer.consumed() >= target[index]), 60_000, "the slow viewer to catch up")
      const caughtUpMs = performance.now() - resumeAt
      await sleep(1_000)
      await queue.stop()
      for (const flood of floods) await control.trpc.terminal.write.mutate({ sessionId: flood.sessionId, data: "q" })
      const settled = await settle(server, [...viewers, ...reference])
      const equalScreens = viewers.filter((viewer, index) => viewer.state() === reference[index].state()).length
      await processes.stop()
      const stats = await connectionStats(server)
      const behindTimes = stats.flatMap((entry) => entry.behindAt).sort((a, b) => a - b)
      const summary = {
        pauseMs,
        serverQueuedPeakMiB: round(Math.max(0, ...stats.map((entry) => entry.peakQueuedBytes)) / MiB, 2),
        behindSent: behindTimes.length,
        firstBehindSentAfterPauseMs: behindTimes.length ? behindTimes[0] - pausedAtEpoch : null,
        lastBehindSentAfterPauseMs: behindTimes.length ? behindTimes.at(-1) - pausedAtEpoch : null,
        wireMiBReceivedAfterResume: round((wireBytes - wireAtResume) / MiB, 2),
        behindReceived: viewers.reduce((sum, viewer) => sum + viewer.behindAt.length, 0),
        behindFrames,
        firstBehindAfterResumeMs: firstBehindAt === null ? null : round(firstBehindAt - resumeAt, 0),
        caughtUpAfterResumeMs: round(caughtUpMs, 0),
        startModes: viewers.map((viewer) => viewer.stream.starts.join(">")).join(" | "),
        screensEqualReference: `${equalScreens}/${viewers.length}`,
        allBytesApplied: settled.allBytesApplied,
        screensEqualFreshSnapshot: settled.screensEqual,
        ...summarizeProcesses(processes.samples, t0 - 1000, performance.now()),
      }
      for (const flood of floods) await control.trpc.terminal.kill.mutate({ sessionId: flood.sessionId })
      for (const viewer of [...reference, ...viewers]) viewer.stream.close()
      await fast.close()
      await slow.close()
      return {
        summary,
        control,
        raw: {
          serverQueued: queue.samples.map((sample) => ({ t: sample.t - pausedAtEpoch, queued: sample.queued })),
          connections: stats.map((entry) => ({ ...entry, behindAt: entry.behindAt.map((at) => at - pausedAtEpoch) })),
          resumeAtMs: round(resumeAt - t0, 0),
          processes: processes.samples.map((sample) => ({
            t: round(sample.t - t0, 0),
            ...Object.fromEntries(Object.entries(sample.groups).map(([name, value]) => [name, { cpuPercent: round(value.cpuPercent, 1), rssMiB: round(value.rssMiB, 1) }])),
          })),
        },
      }
    })
}

/**
 * c: reconnect. One client views N flooding terminals; the server drops every
 * connection `drops` times. `holdMs` > 0 holds the client's reconnect that
 * long, so the daemon's tail has moved past the client's offset (snapshot).
 */
function reconnectRun(terminals, holdMs, drops) {
  return () =>
    withServer(async (server) => {
      const app = await newClient(loopbackUrl(server))
      const floods = []
      for (let index = 0; index < terminals; index++)
        floods.push(await spawnFlood(app, server, "lines", RATE, index))
      const viewers = floods.map((flood) => new Viewer(app, flood.sessionId, "keep"))
      for (const viewer of viewers) await waitFor(() => viewer.screen().includes("R"), 15_000, "the programs to start")
      for (const flood of floods) await app.trpc.terminal.write.mutate({ sessionId: flood.sessionId, data: "g" })
      await sleep(1_000)
      const events = []
      for (let drop = 0; drop < drops; drop++) {
        const startsBefore = viewers.map((viewer) => viewer.stream.starts.length)
        const producedAtDrop = floods.map((flood) => flood.produced())
        const firstApplied = viewers.map(() => null)
        const listeners = viewers.map((viewer, index) => {
          const listener = () => {
            if (firstApplied[index] === null && viewer.stream.starts.length > startsBefore[index]) firstApplied[index] = performance.now()
          }
          viewer.onApplied.push(listener)
          return listener
        })
        if (holdMs > 0) app.holdReconnect(holdMs)
        const droppedAt = performance.now()
        await dropConnections(server)
        await waitFor(() => viewers.every((viewer, index) => viewer.consumed() >= producedAtDrop[index] && firstApplied[index] !== null), 60_000, "every viewer to catch up after the drop")
        const caughtUp = performance.now()
        viewers.forEach((viewer, index) => viewer.onApplied.splice(viewer.onApplied.indexOf(listeners[index]), 1))
        const modes = viewers.map((viewer, index) => viewer.stream.starts.slice(startsBefore[index]).join(">"))
        events.push({
          firstAppliedMs: firstApplied.map((at) => round(at - droppedAt, 1)),
          caughtUpMs: round(caughtUp - droppedAt, 1),
          modes,
          reconnectingSeen: app.states.some((entry) => entry.at > droppedAt && entry.state === "reconnecting"),
        })
        await sleep(2_000)
      }
      for (const flood of floods) await app.trpc.terminal.write.mutate({ sessionId: flood.sessionId, data: "q" })
      // Uninterrupted reference: a fresh viewer's snapshot after the flood stopped.
      const settled = await settle(server, viewers)
      const first = events.flatMap((event) => event.firstAppliedMs)
      const caught = events.map((event) => event.caughtUpMs)
      const modes = events.flatMap((event) => event.modes)
      const summary = {
        holdMs,
        drops,
        firstAppliedP50Ms: round(percentile(first, 50), 1),
        firstAppliedMaxMs: round(Math.max(...first), 1),
        caughtUpP50Ms: round(percentile(caught, 50), 1),
        caughtUpMaxMs: round(Math.max(...caught), 1),
        replays: modes.filter((mode) => mode.startsWith("replay")).length,
        snapshots: modes.filter((mode) => mode.startsWith("snapshot")).length,
        otherStarts: modes.filter((mode) => !mode.startsWith("replay") && !mode.startsWith("snapshot")).length,
        reconnectingShown: events.every((event) => event.reconnectingSeen),
        finalState: app.status.state(),
        screensEqualFreshSnapshot: settled.screensEqual,
        allBytesApplied: settled.allBytesApplied,
      }
      for (const flood of floods) await app.trpc.terminal.kill.mutate({ sessionId: flood.sessionId })
      for (const viewer of viewers) viewer.stream.close()
      return { summary, control: app, raw: { events } }
    })
}

/** g: the real Electron app (tests/flood/appFlood.mjs, run as a child process). */
function appRun() {
  return async () => {
    const script = join(HERE, "appFlood.mjs")
    if (!existsSync(script)) return { skipped: "tests/flood/appFlood.mjs is missing" }
    const out = join(mkdtempSync(join(tmpdir(), "pi-lab-flood-app-")), "app.json")
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, "--seconds", String(SECONDS), "--out", out], { stdio: "inherit" })
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`appFlood.mjs exited with code ${code}`))))
    })
    const result = JSON.parse(readFileSync(out, "utf8"))
    rmSync(dirname(out), { recursive: true, force: true })
    // Flatten appFlood's per-phase summaries ({ n, p50, p95, max } per measure) into one row each.
    const summary = {}
    for (const [phase, values] of Object.entries(result.phases)) {
      for (const [measure, stats] of Object.entries(values.summary)) {
        for (const [stat, value] of Object.entries(stats ?? {})) summary[`${phase}.${measure}.${stat}`] = round(value, 1)
      }
      summary[`${phase}.echoFailures`] = values.echoFailures?.length ?? null
      summary[`${phase}.trpcUnanswered`] = values.trpcUnanswered ?? null
      summary[`${phase}.trpcErrors`] = Array.isArray(values.trpcErrors) ? values.trpcErrors.length : values.trpcErrors ?? null
    }
    return { summary, raw: result }
  }
}

const SCENARIOS = [
  { id: "a1", name: "a. loopback, 1 flooding terminal (lines)", conditions: { transport: "loopback", terminals: 1, mode: "lines" }, run: loopback(1, "lines") },
  { id: "a4", name: "a. loopback, 4 flooding terminals (lines)", conditions: { transport: "loopback", terminals: 4, mode: "lines" }, run: loopback(4, "lines") },
  { id: "a8", name: "a. loopback, 8 flooding terminals (lines)", conditions: { transport: "loopback", terminals: 8, mode: "lines" }, run: loopback(8, "lines") },
  { id: "a4f", name: "a. loopback, 4 flooding terminals (full-screen redraws)", conditions: { transport: "loopback", terminals: 4, mode: "fullscreen" }, run: loopback(4, "fullscreen") },
  { id: "b", name: "b. slow reader (TCP paused 3 s), 4 flooding terminals", conditions: { transport: "loopback", terminals: 4, mode: "lines", pauseMs: 3000 }, run: slowReaderRun(4, 3_000) },
  { id: "c-short", name: "c. reconnect, short drop (immediate reconnect), 4 terminals", conditions: { transport: "loopback", terminals: 4, mode: "lines", holdMs: 0, dropsPerRun: 3 }, run: reconnectRun(4, 0, 3) },
  { id: "c-long", name: "c. reconnect, reconnect held 1.5 s (tail expired), 4 terminals", conditions: { transport: "loopback", terminals: 4, mode: "lines", holdMs: 1500, dropsPerRun: 3 }, run: reconnectRun(4, 1_500, 3) },
  { id: "d", name: "d. SSH tunnel (127.0.0.1 sshd), 4 flooding terminals", conditions: { transport: "ssh tunnel via tunnel.ts to a test sshd on 127.0.0.1", terminals: 4, mode: "lines" }, run: sshTunnelRun() },
  { id: "e", name: "e. SSH tunnel through tripper4 over Tailscale, 4 flooding terminals", conditions: { transport: "ssh tunnel via tunnel.ts to a test sshd on this Mac's Tailscale address, through tripper4 (ProxyCommand)", terminals: 4, mode: "lines" }, run: tailscaleRun(RATE) },
  { id: "e-low", name: "e. SSH tunnel through tripper4 over Tailscale, 4 terminals at 0.5 MiB/s each", conditions: { transport: "ssh tunnel via tunnel.ts to a test sshd on this Mac's Tailscale address, through tripper4 (ProxyCommand)", terminals: 4, mode: "lines", ratePerTerminalBytesPerSecond: MiB / 2 }, run: tailscaleRun(MiB / 2) },
  { id: "f", name: "f. loopback, 4 flooding terminals, Expo build in the background", conditions: { transport: "loopback", terminals: 4, mode: "lines", background: "npx expo export --platform ios --clear (tests/expo-client), restarted until the window ends" }, run: expoBuildRun() },
  { id: "g", name: "g. real Electron app, 4 flooding + 1 quiet terminal visible", conditions: { transport: "Electron renderer to its server (test mode)", terminals: "4 flooding + 1 quiet bash, 5 panes side by side", ratePerTerminalBytesPerSecond: 2 * MiB, smallCalls: "server.hello over a second WebSocket opened from the renderer page (the app's own tRPC client is not reachable)" }, run: appRun() },
]

// ------------------------------------------------------------------- report

function spreadTable(runs) {
  const keys = []
  for (const run of runs) for (const key of Object.keys(run.summary ?? {})) if (!keys.includes(key)) keys.push(key)
  const rows = []
  for (const key of keys) {
    const values = runs.map((run) => run.summary?.[key])
    const numbers = values.filter((value) => typeof value === "number")
    if (numbers.length === values.length && numbers.length > 0) {
      const median = percentile(numbers, 50)
      rows.push([key, String(median), numbers.length > 1 ? `${Math.min(...numbers)} .. ${Math.max(...numbers)}` : "", numbers.join(", ")])
    } else rows.push([key, values.map((value) => String(value)).join(" ; "), "", ""])
  }
  return rows
}

function printTable(label, rows) {
  const widths = [0, 1, 2].map((column) => Math.max(...rows.map((row) => row[column].length), ["metric", "median", "min .. max"][column].length))
  console.log(`\n${label}`)
  console.log(`  ${"metric".padEnd(widths[0])}  ${"median".padEnd(widths[1])}  ${"min .. max".padEnd(widths[2])}  runs`)
  for (const row of rows) console.log(`  ${row[0].padEnd(widths[0])}  ${row[1].padEnd(widths[1])}  ${row[2].padEnd(widths[2])}  ${row[3]}`)
}

// --------------------------------------------------------------------- main

const harnessStart = Date.now()
if (!flag("--skip-build")) execFileSync("bun", ["run", "--cwd", DESKTOP, "build"], { stdio: "inherit" })
if (!existsSync(SERVER_ENTRY)) throw new Error(`no built server at ${SERVER_ENTRY}`)

const report = {
  label: TRIAL ? "trial" : "measured",
  startedAt: new Date().toISOString(),
  machine: machine(),
  settings: {
    runs: RUNS,
    secondsPerWindow: SECONDS,
    floodRatePerTerminalBytesPerSecond: RATE,
    floodProgram: "tests/flood/floodProgram.cjs (numbered coloured lines with CJK, or 24-row full-screen frames; written every 10 ms; counts PTY bytes)",
    terminalSize: `${COLS}x${ROWS}`,
    smallCalls: "server.hello and projects.list alternating, one every 100 ms, not waiting for replies",
    echo: "one letter per 200 ms via terminal.write to a raw-mode echo program, timed until the echo is applied in the client's headless xterm",
    client: "one Node process with the renderer's serverLinks.ts + terminalStream.ts and one @xterm/headless 5.5.0 per terminal",
    provisional: provisionalValues(),
  },
  scenarios: [],
}
for (const scenario of SCENARIOS) {
  if (ONLY && !ONLY.includes(scenario.id)) continue
  console.log(`\n=== ${scenario.name} ===`)
  const entry = { id: scenario.id, name: scenario.name, conditions: scenario.conditions, runs: [] }
  report.scenarios.push(entry)
  for (let index = 1; index <= RUNS; index++) {
    const started = Date.now()
    console.log(`run ${index} of ${RUNS}`)
    const result = await scenario.run().catch((error) => ({ failed: error.stack ?? String(error) }))
    result.seconds = round((Date.now() - started) / 1000, 1)
    entry.runs.push(result)
    if (result.failed) console.error(`FAILED: ${result.failed}`)
    if (result.skipped) {
      console.log(`skipped: ${result.skipped}`)
      break
    }
    if (result.summary) console.log(JSON.stringify(result.summary))
  }
  writeFileSync(OUT, JSON.stringify(report, null, 1))
}
report.totalSeconds = round((Date.now() - harnessStart) / 1000, 0)
writeFileSync(OUT, JSON.stringify(report, null, 1))

console.log(`\n${report.label.toUpperCase()} RESULTS  (${report.machine.cpu}, ${report.machine.cores} cores, ${report.machine.ramGiB} GiB, ${report.machine.os})`)
console.log(`flood rate ${RATE / MiB} MiB/s per terminal, ${SECONDS} s windows, ${RUNS} run(s)`)
for (const entry of report.scenarios) {
  const ok = entry.runs.filter((run) => run.summary)
  if (ok.length === 0) {
    console.log(`\n${entry.name}\n  ${entry.runs.map((run) => run.skipped ? `skipped: ${run.skipped}` : `failed: ${String(run.failed).split("\n")[0]}`).join("\n  ")}`)
    continue
  }
  const failed = entry.runs.length - ok.length
  printTable(`${entry.name}${failed ? ` (${failed} run(s) failed)` : ""}`, spreadTable(ok))
}
console.log(`\nJSON: ${OUT}\ntotal ${report.totalSeconds} s`)
process.exit(0)
