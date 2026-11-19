// Flood scenario "visible terminals in the real app".
//
// Launches the built Electron app (apps/desktop/out) in test mode with a temp
// data dir and a temp git project, opens the project, opens a shell terminal and
// splits it right four times (the "Split right" shortcut has no default binding,
// so this sets one the same way Settings > Shortcuts does: the `pi-lab.shortcuts`
// localStorage key). That gives five terminals side by side: four run a flood
// program, the middle one stays a quiet shell.
//
// Measures, for a baseline phase and then the flood phase, all timed inside the
// renderer (performance.now), never over Playwright round trips:
// - keystroke-to-visible-echo in the quiet terminal (keydown on xterm's textarea
//   until the character count in that terminal's DOM rows goes up),
// - command palette open (⇧⌘P keydown until [data-testid=command-palette] exists)
//   and close (Escape keydown until it is gone),
// - requestAnimationFrame gaps,
// - `server.hello` round trips at 10 per second over a WebSocket opened from the
//   page to the PI Lab server (same endpoint and token the app uses, but a
//   separate socket: the app's own tRPC client is not reachable from the page).
//
// Usage: node tests/flood/appFlood.mjs --seconds S --out <json path>
// Writes one JSON object to --out. Exits non-zero with a message on any failure,
// including processes left running after the app quit.
import { execFile, execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { parseArgs } from "node:util"

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, "..", "..")
const DESKTOP_DIR = join(REPO, "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron")
const { _electron } = createRequire(join(REPO, "package.json"))("@playwright/test")

const BASELINE_SECONDS = 6
const MIN_ECHO_SAMPLES = 30
const ECHO_TIMEOUT_MS = 10_000
const PALETTE_EVERY_MS = 2_000
const TRPC_CALLS_PER_SECOND = 10
const FLOOD_TERMINALS = 4
/** Target output per flooding terminal; the achieved rate is measured. */
const FLOOD_BYTES_PER_SECOND = 2 * 1024 * 1024
const WINDOW_SIZE = { width: 1800, height: 1000 }
const SHELL = "/bin/bash"
const SPLIT_RIGHT_BINDING = "Mod+Alt+r"
const SPLIT_RIGHT_KEYS = "Meta+Alt+r"
/** Characters typed into the quiet terminal, in turn. */
const ECHO_CHARS = "abcdefghijklmnopqrstuvwxyz"

/** Node program each flooding terminal runs: numbered lines at a target rate, byte count to a stats file every second. */
const FLOOD_PROGRAM = `
const { writeFileSync } = require("node:fs")
const [statsPath, rateArg] = process.argv.slice(2)
const rate = Number(rateArg)
const tickMs = 10
const perTick = Math.max(1, Math.round((rate * tickMs) / 1000))
const pad = "x".repeat(70)
let line = 0
let bytes = 0
let blocked = false
const started = Date.now()
process.stdout.on("drain", () => { blocked = false })
setInterval(() => {
  if (blocked) return
  let chunk = ""
  while (chunk.length < perTick) chunk += String(line++).padStart(10, "0") + " " + pad + "\\n"
  bytes += chunk.length
  if (!process.stdout.write(chunk)) blocked = true
}, tickMs)
setInterval(() => {
  writeFileSync(statsPath, JSON.stringify({ bytes, lines: line, elapsedMs: Date.now() - started }))
}, 1000)
`

/** Page-side helpers, installed once with page.evaluate. Everything is timed with performance.now(). */
function installPageHelpers() {
  const state = { raf: null, trpc: null }
  window.__flood = {
    /**
     * Wait for the next keydown matching `key` (and modifiers), then resolve with the ms
     * until `check()` is true, checked on every mutation under `root` and every frame.
     */
    arm(id, spec) {
      const root = spec.root === "terminal" ? document.querySelectorAll('[data-testid="terminal"]')[spec.index] : document.body
      if (!root) throw new Error(`No root for ${spec.root} ${spec.index}`)
      const rows = () => root.querySelector(".xterm-rows")?.textContent ?? ""
      const countOf = (text, ch) => text.split(ch).length - 1
      const check =
        spec.kind === "echo"
          ? (() => { const before = countOf(rows(), spec.char); return () => countOf(rows(), spec.char) > before })()
          : spec.kind === "present"
            ? () => document.querySelector(spec.selector) !== null
            : () => document.querySelector(spec.selector) === null
      const result = new Promise((resolveResult) => {
        let t0 = null
        let done = false
        let observer = null
        const finish = (value) => {
          if (done) return
          done = true
          observer?.disconnect()
          window.removeEventListener("keydown", onKey, true)
          resolveResult(value)
        }
        const test = () => { if (t0 !== null && check()) finish({ ms: performance.now() - t0 }) }
        const frame = () => { if (done) return; test(); requestAnimationFrame(frame) }
        const onKey = (event) => {
          if (t0 !== null || event.key.toLowerCase() !== spec.key.toLowerCase()) return
          if (Boolean(spec.meta) !== event.metaKey || Boolean(spec.shift) !== event.shiftKey) return
          t0 = event.timeStamp
          observer = new MutationObserver(test)
          observer.observe(root, { subtree: true, childList: true, characterData: true })
          requestAnimationFrame(frame)
        }
        window.addEventListener("keydown", onKey, true)
        setTimeout(
          () =>
            finish({
              ms: null,
              error: t0 === null ? "keydown never seen" : "timeout",
              // What the terminal showed at the timeout (the end of its row text).
              rowsTail: spec.kind === "echo" ? rows().trimEnd().slice(-160) : undefined,
            }),
          spec.timeoutMs,
        )
      })
      window.__flood[`result_${id}`] = result
    },
    async take(id) {
      const value = await window.__flood[`result_${id}`]
      delete window.__flood[`result_${id}`]
      return value
    },
    startRaf() {
      const gaps = []
      let last = null
      let running = true
      const tick = (now) => {
        if (!running) return
        if (last !== null) gaps.push(now - last)
        last = now
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      state.raf = { gaps, stop: () => { running = false } }
    },
    stopRaf() {
      state.raf.stop()
      return state.raf.gaps
    },
    /** Open a WebSocket to the server and send `server.hello` every 1000/rate ms. */
    async startTrpc(url, rate) {
      const socket = new WebSocket(url)
      await new Promise((ok, fail) => {
        socket.onopen = ok
        socket.onerror = () => fail(new Error(`WebSocket to the server failed: ${url.replace(/token=[^&]*/u, "token=…")}`))
      })
      const pending = new Map()
      const samples = []
      const errors = []
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data)
        const sentAt = pending.get(message.id)
        if (sentAt === undefined) return
        pending.delete(message.id)
        if (message.error) errors.push(JSON.stringify(message.error).slice(0, 300))
        else samples.push(performance.now() - sentAt)
      }
      let nextId = 1
      const timer = setInterval(() => {
        const id = nextId++
        pending.set(id, performance.now())
        socket.send(JSON.stringify({ id, method: "query", params: { path: "server.hello", input: undefined } }))
      }, 1000 / rate)
      state.trpc = { socket, timer, pending, samples, errors, sent: () => nextId - 1 }
    },
    async stopTrpc() {
      const trpc = state.trpc
      clearInterval(trpc.timer)
      const deadline = performance.now() + 5000
      while (trpc.pending.size > 0 && performance.now() < deadline) await new Promise((ok) => setTimeout(ok, 50))
      trpc.socket.close()
      return { samples: trpc.samples, errors: trpc.errors, sent: trpc.sent(), unanswered: trpc.pending.size }
    },
  }
}

function fail(message) {
  throw new Error(message)
}

function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

function summary(values) {
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length ? Math.max(...values) : null,
  }
}

/** All descendants of `pid` (from one `ps` snapshot). */
function descendants(pid) {
  const rows = execFileSync("ps", ["-ax", "-o", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/u))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }))
  const found = []
  const queue = [pid]
  while (queue.length) {
    const parent = queue.shift()
    for (const row of rows) if (row.ppid === parent) { found.push(row); queue.push(row.pid) }
  }
  return found
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function main() {
  const { values } = parseArgs({ options: { seconds: { type: "string" }, out: { type: "string" } } })
  if (!values.seconds || !values.out) fail("usage: node tests/flood/appFlood.mjs --seconds S --out <json path>")
  const floodSeconds = Number(values.seconds)
  if (!Number.isFinite(floodSeconds) || floodSeconds <= 0) fail(`--seconds must be a positive number, got ${values.seconds}`)
  if (!existsSync(MAIN_ENTRY)) fail(`The app is not built: ${MAIN_ENTRY} is missing`)

  const runStarted = Date.now()
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-flood-app-"))
  const repoDir = join(dataDir, "repo")
  const floodScript = join(dataDir, "flood.cjs")
  const result = {
    scenario: "visible terminals in the real app",
    startedAt: new Date(runStarted).toISOString(),
    conditions: {},
    layout: null,
    phases: {},
    cleanup: {},
  }
  let app = null
  let watched = []
  let serverPid = null
  let failure = null
  try {
    await execFileAsync("git", ["init", "-q", "-b", "main", repoDir])
    await writeFile(join(repoDir, "README.md"), "# Flood fixture\n")
    await writeFile(floodScript, FLOOD_PROGRAM)

    app = await _electron.launch({
      executablePath: ELECTRON_PATH,
      args: [MAIN_ENTRY],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: dataDir,
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
        PI_LAB_TEST_OPEN_PROJECT: repoDir,
        SHELL,
      },
    })
    const electronPid = app.process().pid
    const page = await app.firstWindow()
    await page.getByTestId("app-ready").waitFor({ state: "visible", timeout: 30_000 })
    await app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setSize(size.width, size.height)
    }, WINDOW_SIZE)

    // Split right has no default binding; give it one as Settings > Shortcuts would.
    await page.evaluate(
      ([binding]) => {
        const key = "pi-lab.shortcuts"
        const current = JSON.parse(window.localStorage.getItem(key) ?? "{}")
        window.localStorage.setItem(key, JSON.stringify({ ...current, "split-right": binding }))
      },
      [SPLIT_RIGHT_BINDING],
    )

    await page.getByTestId("project-item").click()
    await page.getByTestId("project-view").waitFor({ state: "visible", timeout: 30_000 })
    await page.getByTestId("central-new-terminal").click()
    const terminals = page.getByTestId("terminal")
    await terminals.first().waitFor({ state: "visible", timeout: 30_000 })
    for (let count = 2; count <= FLOOD_TERMINALS + 1; count++) {
      await terminals.last().locator(".xterm-helper-textarea").focus()
      await page.keyboard.press(SPLIT_RIGHT_KEYS)
      const deadline = Date.now() + 15_000
      while ((await terminals.count()) < count) {
        if (Date.now() > deadline) fail(`Split right did not open terminal ${count}; ${await terminals.count()} terminals`)
        await new Promise((ok) => setTimeout(ok, 100))
      }
    }
    // Wait for every shell to print its prompt.
    const promptDeadline = Date.now() + 20_000
    for (let i = 0; i < FLOOD_TERMINALS + 1; i++) {
      while (((await terminals.nth(i).locator(".xterm-rows").textContent()) ?? "").trim() === "") {
        if (Date.now() > promptDeadline) fail(`Terminal ${i} never showed a prompt`)
        await new Promise((ok) => setTimeout(ok, 100))
      }
    }

    // Terminals in DOM order, with their boxes; check they are all visible at once.
    const boxes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="terminal"]')).map((el, index) => {
        const r = el.getBoundingClientRect()
        const xterm = el.querySelector(".xterm-rows")
        return {
          index,
          sessionId: el.getAttribute("data-session-id"),
          x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height),
          visibleRows: xterm ? xterm.children.length : null,
          inViewport: r.width > 0 && r.height > 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
        }
      }),
    )
    if (boxes.length !== FLOOD_TERMINALS + 1) fail(`Expected ${FLOOD_TERMINALS + 1} terminals, found ${boxes.length}`)
    const hidden = boxes.filter((box) => !box.inViewport)
    if (hidden.length) fail(`Terminals not fully visible: ${JSON.stringify(hidden)}`)
    const byX = [...boxes].sort((a, b) => a.x - b.x)
    const sameRow = new Set(boxes.map((box) => box.y)).size === 1
    const quiet = byX[Math.floor(byX.length / 2)]
    const flooding = byX.filter((box) => box !== quiet)
    result.layout = {
      description: sameRow
        ? `${boxes.length} terminal panes side by side in one row (split right 4 times); quiet terminal is pane ${byX.indexOf(quiet) + 1} from the left`
        : `${boxes.length} terminal panes, not in one row: see panes`,
      allVisibleAtOnce: true,
      panes: byX.map((box) => ({ ...box, role: box === quiet ? "quiet" : "flood" })),
    }

    const env = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    }))
    const versions = await app.evaluate(() => process.versions)
    result.conditions = {
      floodSeconds,
      baselineSeconds: BASELINE_SECONDS,
      electron: versions.electron,
      chromium: versions.chrome,
      electronNode: versions.node,
      harnessNode: process.version,
      platform: `${process.platform} ${process.arch}`,
      window: { requested: WINDOW_SIZE, inner: { width: env.innerWidth, height: env.innerHeight }, devicePixelRatio: env.devicePixelRatio },
      shell: SHELL,
      quietTerminal: "the bash shell at its prompt; typed characters are echoed by readline",
      floodCommand: `'${process.execPath}' <tmp>/flood.cjs <statsFile> ${FLOOD_BYTES_PER_SECOND}`,
      floodProgram: "numbered 81-byte lines written every 10 ms, target bytes per second per terminal; pauses on stdout backpressure",
      floodTerminals: FLOOD_TERMINALS,
      floodTargetBytesPerSecondEach: FLOOD_BYTES_PER_SECOND,
      echoMethod: "keydown on the quiet xterm's helper textarea (event.timeStamp) until the typed character's count in that terminal's .xterm-rows text goes up (MutationObserver + rAF check)",
      paletteMethod: "⇧⌘P keydown until [data-testid=command-palette] exists; Escape keydown until it is gone",
      trpcMethod: `server.hello at ${TRPC_CALLS_PER_SECOND}/s over a WebSocket opened from the page to the PI Lab server with the local token (separate socket from the app's own client)`,
      echoTimeoutMs: ECHO_TIMEOUT_MS,
      testMode: "PI_LAB_TEST_MODE=1, temp data dir, temp git project",
    }

    // Processes to check at the end: the app's tree and the server's tree.
    const discovery = JSON.parse(readFileSync(join(dataDir, "server.json"), "utf8"))
    serverPid = discovery.pid
    const token = readFileSync(join(dataDir, "server-token"), "utf8").trim()
    const serverUrl = `ws://127.0.0.1:${discovery.port}/trpc?token=${encodeURIComponent(token)}`

    await page.evaluate(installPageHelpers)
    const quietInput = terminals.nth(quiet.index).locator(".xterm-helper-textarea")
    let armId = 0
    let charIndex = 0

    /** Arm a page-side timer for the next matching keydown, press the keys, and read the result. */
    async function timedPress(spec, keys) {
      const id = ++armId
      await page.evaluate(([i, s]) => window.__flood.arm(i, s), [id, { ...spec, timeoutMs: ECHO_TIMEOUT_MS }])
      await page.keyboard.press(keys)
      return page.evaluate((i) => window.__flood.take(i), id)
    }

    async function runPhase(name, seconds) {
      const echo = []
      const echoFailures = []
      const paletteOpen = []
      const paletteClose = []
      const paletteFailures = []
      await quietInput.focus()
      await page.evaluate(() => window.__flood.startRaf())
      await page.evaluate(([url, rate]) => window.__flood.startTrpc(url, rate), [serverUrl, TRPC_CALLS_PER_SECOND])
      const started = Date.now()
      let lastPalette = started
      let typedOnLine = 0
      while (Date.now() - started < seconds * 1000 || echo.length + echoFailures.length < MIN_ECHO_SAMPLES) {
        if (Date.now() - started > (seconds + 120) * 1000) fail(`${name}: could not collect ${MIN_ECHO_SAMPLES} echo samples`)
        const char = ECHO_CHARS[charIndex++ % ECHO_CHARS.length]
        const sample = await timedPress({ kind: "echo", root: "terminal", index: quiet.index, char, key: char }, char)
        if (sample.ms === null) echoFailures.push({ char, error: sample.error, rowsTail: sample.rowsTail, atMs: Date.now() - started })
        else echo.push(sample.ms)
        typedOnLine++
        if (typedOnLine >= 20) {
          await page.keyboard.press("Control+u")
          typedOnLine = 0
        }
        if (Date.now() - lastPalette >= PALETTE_EVERY_MS) {
          lastPalette = Date.now()
          const open = await timedPress(
            { kind: "present", selector: '[data-testid="command-palette"]', key: "p", meta: true, shift: true },
            "Meta+Shift+p",
          )
          if (open.ms === null) paletteFailures.push({ step: "open", error: open.error })
          else paletteOpen.push(open.ms)
          const close = await timedPress({ kind: "absent", selector: '[data-testid="command-palette"]', key: "Escape" }, "Escape")
          if (close.ms === null) paletteFailures.push({ step: "close", error: close.error })
          else paletteClose.push(close.ms)
          await quietInput.focus()
        }
        await new Promise((ok) => setTimeout(ok, 100))
      }
      const durationMs = Date.now() - started
      const rafGaps = await page.evaluate(() => window.__flood.stopRaf())
      const trpc = await page.evaluate(() => window.__flood.stopTrpc())
      await page.keyboard.press("Control+u")
      result.phases[name] = {
        durationMs,
        echoMs: echo,
        echoFailures,
        paletteOpenMs: paletteOpen,
        paletteCloseMs: paletteClose,
        paletteFailures,
        rafGapMs: rafGaps,
        trpcHelloMs: trpc.samples,
        trpcSent: trpc.sent,
        trpcUnanswered: trpc.unanswered,
        trpcErrors: trpc.errors,
        summary: {
          echoMs: summary(echo),
          paletteOpenMs: summary(paletteOpen),
          paletteCloseMs: summary(paletteClose),
          rafGapMs: summary(rafGaps),
          trpcHelloMs: summary(trpc.samples),
        },
      }
      console.log(`[appFlood] ${name}: ${JSON.stringify(result.phases[name].summary)}`)
    }

    await runPhase("baseline", BASELINE_SECONDS)

    // Start the flood in the four outer terminals.
    const statsFiles = flooding.map((_, i) => join(dataDir, `flood-${i}.json`))
    for (const [i, pane] of flooding.entries()) {
      await terminals.nth(pane.index).locator(".xterm-helper-textarea").focus()
      await page.keyboard.type(`'${process.execPath}' '${floodScript}' '${statsFiles[i]}' ${FLOOD_BYTES_PER_SECOND}`)
      await page.keyboard.press("Enter")
    }
    // The flood is running once every stats file exists.
    const floodDeadline = Date.now() + 15_000
    while (!statsFiles.every((file) => existsSync(file))) {
      if (Date.now() > floodDeadline) fail(`Flood programs did not start: ${statsFiles.filter((f) => !existsSync(f)).join(", ")}`)
      await new Promise((ok) => setTimeout(ok, 100))
    }
    const statsBefore = statsFiles.map((file) => JSON.parse(readFileSync(file, "utf8")))
    await runPhase("flood", floodSeconds)
    const statsAfter = statsFiles.map((file) => JSON.parse(readFileSync(file, "utf8")))
    const rates = statsAfter.map((after, i) => {
      const bytes = after.bytes - statsBefore[i].bytes
      const ms = after.elapsedMs - statsBefore[i].elapsedMs
      return { bytes, ms, bytesPerSecond: ms > 0 ? Math.round((bytes * 1000) / ms) : null }
    })
    result.conditions.floodMeasuredOutput = {
      note: "bytes written by each flood program during the flood phase, from its stats file (updated every second)",
      perTerminal: rates,
      totalBytesPerSecond: rates.reduce((sum, rate) => sum + (rate.bytesPerSecond ?? 0), 0),
    }

    watched = [
      { pid: electronPid, command: "electron" },
      ...descendants(electronPid),
      { pid: serverPid, command: "server" },
      ...descendants(serverPid),
    ]
  } catch (error) {
    failure = error
  }

  // Quit the app (answering the quit dialog) and check nothing is left running.
  if (app) {
    if (watched.length === 0) {
      const pid = app.process().pid
      watched = [{ pid, command: "electron" }, ...descendants(pid)]
      if (serverPid) watched.push({ pid: serverPid, command: "server" }, ...descendants(serverPid))
    }
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
      })
      .catch(() => undefined)
    let closeTimer = null
    const closed = await Promise.race([
      app.close().then(() => true),
      new Promise((ok) => { closeTimer = setTimeout(() => ok(false), 30_000) }),
    ])
    clearTimeout(closeTimer)
    result.cleanup.appClosedWithin30s = closed
    const deadline = Date.now() + 15_000
    while (watched.some((proc) => alive(proc.pid)) && Date.now() < deadline) await new Promise((ok) => setTimeout(ok, 200))
    const left = watched.filter((proc) => alive(proc.pid))
    for (const proc of left) process.kill(proc.pid, "SIGKILL")
    result.cleanup = {
      ...result.cleanup,
      watchedProcesses: watched.length,
      leftRunningAfterQuit: left.map((proc) => ({ pid: proc.pid, command: proc.command.slice(0, 200) })),
    }
    if (left.length && !failure) failure = new Error(`Processes still running 15 s after quit (killed): ${JSON.stringify(result.cleanup.leftRunningAfterQuit)}`)
  }
  await rm(dataDir, { recursive: true, force: true })
  result.cleanup.dataDirRemoved = !existsSync(dataDir)
  result.runDurationMs = Date.now() - runStarted
  if (failure) result.error = String(failure.stack ?? failure)
  await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`)
  if (failure) {
    console.error(`[appFlood] FAILED: ${failure.message}`)
    process.exit(1)
  }
  console.log(`[appFlood] done in ${Math.round(result.runDurationMs / 1000)} s; wrote ${values.out}`)
}

await main()
