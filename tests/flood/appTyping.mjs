// Typing tests in the real app (md/branch-connection-layer.md, "Screen diffs
// and local echo"; done check "Typing" in md/plans/multi-machine-step1.md).
//
// Launches the built Electron app (apps/desktop/out) in test mode with a temp
// data dir and a temp git project. The renderer's two server sockets go
// through a TCP proxy started here (test seam PI_LAB_TEST_RENDERER_PROXY_PORT):
//   --link <ms>       the proxy delays every chunk by <ms>/2 each way (round trip <ms>)
//   --link tailscale  the proxy forwards into an SSH tunnel to the app's server
//                     through tripper4 over Tailscale (as flood scenario e)
// Electron main keeps its own direct connection; only the renderer is slowed.
//
// Tasks (--task):
//   latency  type --keys keys at 10 per second into bash; per key, keydown to
//            the first visible character: a local echo prediction (decoration
//            text) or xterm's own rows. Reported with --echo adaptive and off.
//   hidden   prompts that hide input (read -s, Python getpass, a sudo-like
//            prompt): every prediction drawn is recorded; none may show.
//            Then --trials race trials: a program turns ECHO off at a random
//            time while a key is in flight; counts how often the hidden key
//            was drawn and for how long.
//   reject   a raw-mode program that echoes uppercase, and vi normal mode:
//            a wrong prediction disappears within one ack window, xterm never
//            holds a typed lowercase letter, and the screen equals a fresh
//            snapshot from the daemon.
//
// Usage: node tests/flood/appTyping.mjs --task latency|hidden|reject --link <ms>|tailscale
//          [--echo adaptive|always|off] [--keys N] [--trials N] --out <json path>
import { execFile, execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { createServer, connect as tcpConnect } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs, promisify } from "node:util"
import "./tsResolve.mjs"

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, "..", "..")
const DESKTOP_DIR = join(REPO, "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron")
const { _electron } = createRequire(join(REPO, "package.json"))("@playwright/test")
const JUMP_HOST = "tripper4"
const SHELL = "/bin/bash"
const KEY_INTERVAL_MS = 100
const CHARS = "abcdefghijklmnopqrstuvwxyz"

function fail(message) {
  throw new Error(message)
}

function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}

const round = (value) => (value === null ? null : Math.round(value * 10) / 10)

/**
 * A TCP proxy for the renderer's sockets. Each connection waits for
 * `target()` (the server port, or the tunnel's local port), then bytes go out
 * `delayMs / 2` after they arrive, both ways, in order.
 */
async function startProxy(target, delayMs) {
  const sockets = new Set()
  const server = createServer(async (downstream) => {
    sockets.add(downstream)
    downstream.pause()
    const port = await target()
    const upstream = tcpConnect(port, "127.0.0.1")
    sockets.add(upstream)
    const half = delayMs / 2
    const forward = (to) => (bytes) => {
      if (half === 0) to.write(bytes)
      else setTimeout(() => !to.destroyed && to.write(bytes), half)
    }
    downstream.on("data", forward(upstream))
    upstream.on("data", forward(downstream))
    const end = () => {
      setTimeout(() => {
        downstream.destroy()
        upstream.destroy()
      }, half)
    }
    for (const socket of [downstream, upstream]) {
      socket.on("close", end)
      socket.on("error", end)
    }
    downstream.resume()
  })
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok))
  return {
    port: server.address().port,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((ok) => server.close(ok))
    },
  }
}

/** Page-side recorder: keydowns, prediction drawings and xterm row text, timed with performance.now(). */
function installPageRecorder() {
  const terminal = () => document.querySelector('[data-testid="terminal"]')
  const state = {
    keys: [],
    predictions: [],
    rowsCounts: {},
    observer: null,
  }
  const rowsText = () => terminal()?.querySelector(".xterm-rows")?.textContent ?? ""
  const count = (text, ch) => text.split(ch).length - 1
  const check = () => {
    const now = performance.now()
    const text = rowsText()
    for (const ch of new Set(state.keys.filter((key) => key.echoAt === null).map((key) => key.key))) {
      const current = count(text, ch)
      const before = state.rowsCounts[ch] ?? 0
      if (current < before) state.rowsCounts[ch] = current
      let added = current - (state.rowsCounts[ch] ?? 0)
      for (const key of state.keys) {
        if (added <= 0) break
        if (key.key === ch && key.echoAt === null) {
          key.echoAt = now
          added -= 1
        }
      }
      state.rowsCounts[ch] = current
    }
    for (const element of terminal()?.querySelectorAll(".pi-lab-prediction") ?? []) {
      const ch = element.textContent ?? ""
      if (element.dataset.seen === ch) continue
      element.dataset.seen = ch
      state.predictions.push({ at: now, chars: ch, cursorRow: null })
      const key = state.keys.find((entry) => entry.key === ch && entry.predictedAt === null)
      if (key) key.predictedAt = now
    }
  }
  window.__typing = {
    start() {
      state.keys = []
      state.predictions = []
      state.rowsCounts = {}
      for (const ch of "abcdefghijklmnopqrstuvwxyz0123456789") state.rowsCounts[ch] = count(rowsText(), ch)
      state.observer?.disconnect()
      state.observer = new MutationObserver(check)
      state.observer.observe(terminal(), { subtree: true, childList: true, characterData: true, attributes: true })
      const frame = () => {
        if (!state.observer) return
        check()
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
      window.addEventListener(
        "keydown",
        (state.onKey = (event) => {
          if (event.key.length === 1) {
            state.rowsCounts[event.key] ??= count(rowsText(), event.key)
            state.keys.push({ key: event.key, at: event.timeStamp, echoAt: null, predictedAt: null })
          }
        }),
        true,
      )
    },
    stop() {
      check()
      state.observer?.disconnect()
      state.observer = null
      window.removeEventListener("keydown", state.onKey, true)
      return { keys: state.keys, predictions: state.predictions }
    },
    /** Predictions drawn right now. */
    drawn() {
      return Array.from(terminal()?.querySelectorAll(".pi-lab-prediction") ?? [], (element) => element.textContent)
    },
    rows() {
      return rowsText()
    },
  }
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((ok) => setTimeout(ok, 50))
  }
  fail(`timed out waiting for ${what}`)
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

/** Launch the app with the proxy in front of the renderer, open a project and one terminal. */
async function launch({ link, echo }) {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-typing-"))
  const repoDir = join(dataDir, "repo")
  await execFileAsync("git", ["init", "-q", "-b", "main", repoDir])
  await writeFile(join(repoDir, "README.md"), "# Typing fixture\n")
  const serverPort = async () => {
    await waitFor(() => existsSync(join(dataDir, "server.json")), 60_000, "server.json")
    return JSON.parse(readFileSync(join(dataDir, "server.json"), "utf8")).port
  }
  let tunnel = null
  let sshd = null
  let target = serverPort
  const conditions = { link }
  if (link === "tailscale") {
    const address = execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8" }).trim().split("\n")[0]
    const { startSshTestServer } = await import(join(REPO, "tests/support/sshTestServer.ts"))
    const { SshTunnel } = await import(join(DESKTOP_DIR, "src/main/server/tunnel.ts"))
    sshd = await startSshTestServer(address)
    const jump = ["-o", `ProxyCommand=ssh -o BatchMode=yes -o ConnectTimeout=10 ${JUMP_HOST} -W %h:%p`]
    let opening = null
    target = () => {
      opening ??= (async () => {
        const port = await serverPort()
        tunnel = await SshTunnel.open({
          host: sshd.host,
          remotePort: port,
          sshPath: "/usr/bin/ssh",
          extraSshArgs: [...sshd.clientArgs, ...jump],
          serverAliveIntervalSeconds: 5,
          serverAliveCountMax: 3,
          openTimeoutMs: 20_000,
          backoff: { initialMs: 100, maxMs: 1_000 },
          onState: () => {},
          log: () => {},
        })
        return tunnel.localPort
      })()
      return opening
    }
    const ping = await execFileAsync("ping", ["-c", "5", JUMP_HOST]).then(
      ({ stdout }) => stdout.match(/= [\d.]+\/([\d.]+)\//)?.[1] ?? null,
      () => null,
    )
    conditions.jumpPingAvgMs = ping === null ? null : Number(ping)
    conditions.transport = `renderer -> local proxy -> ssh tunnel via ${JUMP_HOST} (Tailscale) -> test sshd on this Mac -> server`
  } else {
    conditions.roundTripMs = Number(link)
    conditions.transport = `renderer -> local proxy adding ${Number(link) / 2} ms each way -> server`
  }
  const proxy = await startProxy(target, link === "tailscale" ? 0 : Number(link))
  const app = await _electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: repoDir,
      PI_LAB_TEST_RENDERER_PROXY_PORT: String(proxy.port),
      SHELL,
    },
  })
  const page = await app.firstWindow()
  if (process.env.DEBUG_TYPING) page.on("console", (message) => console.log(`[page] ${message.text()}`))
  await page.getByTestId("app-ready").waitFor({ state: "visible", timeout: 90_000 })
  await page.evaluate((mode) => window.localStorage.setItem("pi-lab.terminal.localEcho", mode), echo)
  await page.getByTestId("project-item").click()
  await page.getByTestId("project-view").waitFor({ state: "visible", timeout: 60_000 })
  await page.getByTestId("central-new-terminal").click()
  const terminal = page.getByTestId("terminal").first()
  await terminal.waitFor({ state: "visible", timeout: 60_000 })
  await waitFor(async () => ((await terminal.locator(".xterm-rows").textContent()) ?? "").trim() !== "", 60_000, "a shell prompt")
  await terminal.locator(".xterm-helper-textarea").focus()
  await page.evaluate(installPageRecorder)
  const close = async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    }).catch(() => undefined)
    await Promise.race([app.close(), sleep(30_000)])
    await tunnel?.close()
    await sshd?.stop()
    await proxy.close()
    await rm(dataDir, { recursive: true, force: true })
  }
  return { app, page, terminal, dataDir, conditions, close }
}

/** Run a shell command line in the terminal and wait until `ready` shows. */
async function run(page, command, ready) {
  await page.keyboard.type(command, { delay: 5 })
  await page.keyboard.press("Enter")
  await waitFor(async () => (await page.evaluate(() => window.__typing.rows())).includes(ready), 30_000, ready)
}

async function latencyTask(page, keys) {
  // Warm up: a few keys so the round trip is measured, then clear the line.
  for (const ch of "warmup") {
    await page.keyboard.press(ch)
    await sleep(KEY_INTERVAL_MS)
  }
  await sleep(1_000)
  await page.keyboard.press("Control+u")
  await sleep(1_000)
  await page.evaluate(() => window.__typing.start())
  for (let index = 0; index < keys; index++) {
    if (index > 0 && index % 40 === 0) {
      await sleep(1_500)
      await page.keyboard.press("Control+u")
      await sleep(1_000)
    }
    await page.keyboard.press(CHARS[index % CHARS.length])
    await sleep(KEY_INTERVAL_MS)
  }
  await sleep(2_000)
  const recorded = await page.evaluate(() => window.__typing.stop())
  const visible = []
  const echoed = []
  const predicted = []
  let missing = 0
  for (const key of recorded.keys) {
    const first = [key.echoAt, key.predictedAt].filter((value) => value !== null)
    if (first.length === 0) {
      missing += 1
      continue
    }
    visible.push(Math.min(...first) - key.at)
    if (key.echoAt !== null) echoed.push(key.echoAt - key.at)
    if (key.predictedAt !== null) predicted.push(key.predictedAt - key.at)
  }
  return {
    keys: recorded.keys.length,
    notVisible: missing,
    predictedKeys: predicted.length,
    visibleMs: { p50: round(percentile(visible, 50)), p95: round(percentile(visible, 95)) },
    echoMs: { p50: round(percentile(echoed, 50)), p95: round(percentile(echoed, 95)) },
    predictionMs: { p50: round(percentile(predicted, 50)), p95: round(percentile(predicted, 95)) },
  }
}

const RACE_PROGRAM = `
import random, sys, termios, time
fd = 0
random.seed(int(sys.argv[1]))
n = 0
while True:
    attrs = termios.tcgetattr(fd)
    attrs[3] |= termios.ECHO | termios.ICANON
    termios.tcsetattr(fd, termios.TCSANOW, attrs)
    termios.tcflush(fd, termios.TCIFLUSH)
    sys.stdout.write(f"\\r\\nT{n}>")
    sys.stdout.flush()
    time.sleep(random.uniform(0.05, 0.45))
    attrs[3] &= ~termios.ECHO
    termios.tcsetattr(fd, termios.TCSANOW, attrs)
    time.sleep(0.9)
    n += 1
`

async function hiddenTask(page, dataDir, trials) {
  const prompts = []
  for (const [name, command, prompt] of [
    ["read -s", "read -r -s -p 'Secret: ' answer; echo; echo READ-DONE", "Secret: "],
    ["Python getpass", "python3 -c \"import getpass; getpass.getpass('Password: '); print('GETPASS-DONE')\"", "Password: "],
    ["sudo-like prompt", "bash -c 'stty -echo; printf \"[sudo] password for tester: \"; read -r p; stty echo; echo; echo SUDO-DONE'", "[sudo] password"],
  ]) {
    await page.keyboard.press("Control+u")
    await run(page, command, prompt)
    await page.evaluate(() => window.__typing.start())
    for (const ch of "hunter2x") {
      await page.keyboard.press(ch)
      await sleep(KEY_INTERVAL_MS)
    }
    await sleep(1_500)
    await page.keyboard.press("Enter")
    await sleep(1_500)
    const recorded = await page.evaluate(() => window.__typing.stop())
    const rows = await page.evaluate(() => window.__typing.rows())
    prompts.push({
      prompt: name,
      predictionsDrawn: recorded.predictions.map((entry) => entry.chars),
      typedCharactersOnScreen: [..."hunter2x"].filter((ch) => rows.split(prompt).at(-1)?.includes("hunter2x")).length,
    })
  }
  // The race: ECHO turns off at a random time while a key is in flight.
  const script = join(dataDir, "race.py")
  await writeFile(script, RACE_PROGRAM)
  await page.keyboard.press("Control+u")
  await run(page, `python3 '${script}' 7`, "T0>")
  let leaks = 0
  const leakMs = []
  let hiddenKeys = 0
  for (let trial = 0; trial < trials; trial++) {
    const prompt = `T${trial}>`
    await waitFor(async () => (await page.evaluate(() => window.__typing.rows())).includes(prompt), 10_000, prompt)
    await page.evaluate(() => window.__typing.start())
    // "a" is echoed (it confirms the epoch); "z" goes out at a random time and may meet ECHO off.
    await page.keyboard.press("a")
    await sleep(Math.random() * 400)
    await page.keyboard.press("z")
    await waitFor(async () => (await page.evaluate(() => window.__typing.rows())).includes(`T${trial + 1}>`), 10_000, `T${trial + 1}>`)
    const recorded = await page.evaluate(() => window.__typing.stop())
    const rows = await page.evaluate(() => window.__typing.rows())
    const line = rows.split(prompt).at(-1)?.split(`T${trial + 1}>`)[0] ?? ""
    const zHidden = !line.includes("z")
    if (!zHidden) continue
    hiddenKeys += 1
    const drawn = recorded.predictions.filter((entry) => entry.chars === "z")
    if (drawn.length > 0) {
      leaks += 1
      const z = recorded.keys.find((key) => key.key === "z")
      leakMs.push(Math.max(...drawn.map((entry) => entry.at)) - (z?.predictedAt ?? drawn[0].at))
    }
  }
  await page.keyboard.press("Control+c")
  return {
    prompts,
    race: {
      trials,
      hiddenKeys,
      hiddenKeysDrawn: leaks,
      rate: hiddenKeys === 0 ? null : round((leaks / hiddenKeys) * 100),
      drawnForMs: { p50: round(percentile(leakMs, 50)), max: round(leakMs.length ? Math.max(...leakMs) : null) },
    },
  }
}

const UPPERCASE_PROGRAM = `
process.stdin.setRawMode(true)
process.stdout.write("UPPER>")
process.stdin.on("data", (data) => {
  const text = data.toString()
  if (text === "\\u0003") process.exit(0)
  process.stdout.write(text.toUpperCase())
})
`

async function rejectTask(page, dataDir, roundTripMs) {
  const results = []
  const script = join(dataDir, "upper.cjs")
  await writeFile(script, UPPERCASE_PROGRAM)
  await run(page, `node '${script}'`, "UPPER>")
  await page.evaluate(() => window.__typing.start())
  // Digits are echoed the same: they confirm an epoch, so the letters after them show.
  for (const ch of "123abcdefgh") {
    await page.keyboard.press(ch)
    await sleep(KEY_INTERVAL_MS)
  }
  await sleep(2_000)
  let recorded = await page.evaluate(() => window.__typing.stop())
  let rows = await page.evaluate(() => window.__typing.rows())
  const drawnLetters = recorded.predictions.filter((entry) => /[a-h]/.test(entry.chars))
  const lastLetterKey = recorded.keys.filter((key) => /[a-h]/.test(key.key)).at(-1)
  results.push({
    program: "raw mode, echoes uppercase",
    lettersDrawnAsPredictions: drawnLetters.length,
    predictionsLeftAfter2s: (await page.evaluate(() => window.__typing.drawn())).length,
    lowercaseOnScreen: /UPPER>[^\n]*[a-h]/.test(rows),
    lastPredictionAfterLastKeyMs: drawnLetters.length && lastLetterKey ? round(drawnLetters.at(-1).at - lastLetterKey.at) : null,
    ackWindowMs: roundTripMs === null ? null : roundTripMs + 50,
  })
  await page.keyboard.press("Control+c")
  await sleep(500)
  await run(page, "vi -u NONE", "~")
  await page.evaluate(() => window.__typing.start())
  for (const ch of "jjkkhl") {
    await page.keyboard.press(ch)
    await sleep(KEY_INTERVAL_MS)
  }
  await sleep(1_500)
  recorded = await page.evaluate(() => window.__typing.stop())
  rows = await page.evaluate(() => window.__typing.rows())
  results.push({
    program: "vi normal mode (alternate screen)",
    predictionsDrawn: recorded.predictions.length,
    typedLettersOnScreen: /[jkhl]{2}/.test(rows),
  })
  await page.keyboard.type(":q!")
  await page.keyboard.press("Enter")
  return results
}

async function main() {
  const { values } = parseArgs({
    options: {
      task: { type: "string" },
      link: { type: "string" },
      echo: { type: "string" },
      keys: { type: "string" },
      trials: { type: "string" },
      out: { type: "string" },
    },
  })
  if (!values.task || !values.link || !values.out) fail("usage: --task latency|hidden|reject --link <ms>|tailscale --out <json>")
  if (!existsSync(MAIN_ENTRY)) fail(`The app is not built: ${MAIN_ENTRY} is missing`)
  const echo = values.echo ?? "adaptive"
  const started = Date.now()
  const session = await launch({ link: values.link, echo })
  const result = { task: values.task, echo, conditions: session.conditions, startedAt: new Date(started).toISOString() }
  let failure = null
  try {
    if (values.task === "latency") result.latency = await latencyTask(session.page, Number(values.keys ?? "200"))
    else if (values.task === "hidden")
      result.hidden = await hiddenTask(session.page, session.dataDir, Number(values.trials ?? "1000"))
    else if (values.task === "reject")
      result.reject = await rejectTask(session.page, session.dataDir, values.link === "tailscale" ? null : Number(values.link))
    else fail(`unknown task ${values.task}`)
  } catch (error) {
    failure = error
    result.error = String(error.stack ?? error)
  }
  await session.close()
  result.seconds = Math.round((Date.now() - started) / 1000)
  await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result, null, 2))
  if (failure) process.exit(1)
}

await main()
