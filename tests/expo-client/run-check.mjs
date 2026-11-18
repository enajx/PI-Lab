#!/usr/bin/env node
// Expo reconnect check (md/plans/multi-machine-step1.md, PR 2, "Order of work"
// item 1), end to end on the iOS simulator:
//   1. start the built PI Lab server (apps/desktop/out/main/server.js, Electron
//      binary in Node mode, test mode, temp data folder) and a terminal session
//      that prints numbered lines without pause;
//   2. start a collector on 127.0.0.1:47913 (the address built into the app;
//      the simulator reaches the Mac's 127.0.0.1) and launch the Expo app,
//      which asks the collector for the server URL, local token and session;
//   3. the app attaches (snapshot), holds its emulator so a chunk is queued, and
//      asks for a drop; this script calls POST /test/drop-connections; the app
//      reconnects and resubscribes from its consumed offset (replay);
//   4. this script reads the server's bytes again (a replay on a new connection
//      from the app's first byte) and compares them with what the app applied.
// Exits non-zero on any failure.
//
// Usage: node tests/expo-client/run-check.mjs [--runs N] [--skip-desktop-build] [--skip-ios-build]

import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, "..", "..")
const DESKTOP = join(REPO, "apps", "desktop")
const SERVER_ENTRY = join(DESKTOP, "out", "main", "server.js")
const PROGRAM = join(REPO, "packages", "pty-daemon", "src", "testPrograms", "screenProgram.cjs")
const BUNDLE_ID = "dev.pilab.expocheck"
const DEVICE_NAME = "PI Lab Expo Check"
const XCODE = "/Applications/Xcode.app/Contents/Developer"
const COLLECTOR_PORT = 47913
const COLS = 80
const ROWS = 24

const desktopRequire = createRequire(join(DESKTOP, "package.json"))
const ELECTRON = desktopRequire("electron")
const { createTRPCClient, createWSClient, wsLink } = desktopRequire("@trpc/client")

const args = process.argv.slice(2)
const runs = Number(args[args.indexOf("--runs") + 1] ?? "1") || 1
const skipDesktopBuild = args.includes("--skip-desktop-build")
const skipIosBuild = args.includes("--skip-ios-build")
const env = { ...process.env, DEVELOPER_DIR: XCODE }

function run(command, commandArgs, options = {}) {
  console.log(`$ ${command} ${commandArgs.join(" ")}`)
  return execFileSync(command, commandArgs, { env, stdio: "inherit", ...options })
}

function simctl(commandArgs) {
  return execFileSync("xcrun", ["simctl", ...commandArgs], { env, encoding: "utf8" })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(50)
  }
  throw new Error(`timed out waiting for ${what}`)
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- simulator

/** The check's simulator device (created once, on the newest iOS runtime). */
function device() {
  const devices = JSON.parse(simctl(["list", "devices", "available", "-j"])).devices
  for (const list of Object.values(devices)) {
    const found = list.find((entry) => entry.name === DEVICE_NAME)
    if (found) return found.udid
  }
  const runtimes = JSON.parse(simctl(["list", "runtimes", "available", "-j"])).runtimes.filter(
    (runtime) => runtime.platform === "iOS",
  )
  const runtime = runtimes.at(-1)
  if (!runtime) throw new Error("no available iOS simulator runtime")
  const type = runtime.supportedDeviceTypes.find((entry) => entry.productFamily === "iPhone")
  if (!type) throw new Error(`no iPhone device type for ${runtime.identifier}`)
  console.log(`creating simulator ${DEVICE_NAME} (${type.name}, ${runtime.name})`)
  return simctl(["create", DEVICE_NAME, type.identifier, runtime.identifier]).trim()
}

function bootDevice(udid) {
  const devices = JSON.parse(simctl(["list", "devices", "-j"])).devices
  const state = Object.values(devices)
    .flat()
    .find((entry) => entry.udid === udid)?.state
  if (state !== "Booted") simctl(["boot", udid])
  simctl(["bootstatus", udid, "-b"])
}

function buildApp(udid) {
  const ios = join(HERE, "ios")
  if (!existsSync(ios))
    run("npx", ["expo", "prebuild", "--platform", "ios"], { cwd: HERE, env: { ...env, CI: "1" } })
  const workspace = readdirSync(ios).find((name) => name.endsWith(".xcworkspace"))
  if (!workspace) throw new Error("no .xcworkspace in ios/ (did pod install run?)")
  run(
    "xcodebuild",
    [
      "-workspace",
      join(ios, workspace),
      "-scheme",
      workspace.replace(/\.xcworkspace$/, ""),
      "-configuration",
      "Release",
      "-sdk",
      "iphonesimulator",
      "-destination",
      `id=${udid}`,
      "-derivedDataPath",
      join(ios, "build"),
      "-quiet",
      "build",
    ],
    { cwd: HERE },
  )
}

function appPath() {
  const products = join(HERE, "ios", "build", "Build", "Products", "Release-iphonesimulator")
  const app = existsSync(products)
    ? readdirSync(products).find((name) => name.endsWith(".app"))
    : undefined
  if (!app) throw new Error(`no built app in ${products}`)
  return join(products, app)
}

// ------------------------------------------------------------------- server

function startServer(dataDir) {
  const child = spawn(ELECTRON, [SERVER_ENTRY], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PI_LAB_TEST_MODE: "1",
      PI_LAB_CHANNEL: "alpha",
      PI_LAB_DATA_DIR: dataDir,
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
  child.stdout.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`))
  child.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`))
  return child
}

function discovery(dataDir) {
  const file = join(dataDir, "server.json")
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null
}

function connect(port, token) {
  const ws = createWSClient({
    url: `ws://127.0.0.1:${port}/trpc?token=${encodeURIComponent(token)}`,
  })
  return { client: createTRPCClient({ links: [wsLink({ client: ws })] }), close: () => ws.close() }
}

/**
 * Subscribe on a new connection and collect the bytes from the start event
 * on, until `stop` says so. Fails on any gap or duplicate offset.
 */
function readStream(client, sessionId, resume) {
  const collected = { start: null, bytes: [], end: null, error: null, lastAt: Date.now() }
  const subscription = client.terminal.output.subscribe(
    { sessionId, resume },
    {
      onData: ({ data }) => {
        collected.lastAt = Date.now()
        if (data.type === "start") {
          if (collected.start !== null) collected.error = "a second start on the reference stream"
          collected.start = data
          collected.end = data.offset
        }
        if (data.type !== "start" && data.type !== "data") return
        if (data.offset !== collected.end) {
          collected.error = `reference stream: ${data.type} at ${data.offset}, expected ${collected.end}`
        }
        const bytes = Buffer.from(data.base64, "base64")
        collected.bytes.push(bytes)
        collected.end = data.offset + bytes.length
      },
      onError: (error) => {
        collected.error = `reference stream: ${error.message}`
      },
    },
  )
  return { collected, unsubscribe: () => subscription.unsubscribe() }
}

// ---------------------------------------------------------------- collector

/** The HTTP server the app reports to; `handlers[path](body)` gives the JSON reply. */
function startCollector(handlers) {
  const server = createServer((request, response) => {
    let text = ""
    request.on("data", (chunk) => {
      text += chunk
    })
    request.on("end", () => {
      const handler = handlers[request.url]
      if (!handler) {
        response.writeHead(404).end()
        return
      }
      Promise.resolve(handler(JSON.parse(text || "{}"))).then(
        (reply) =>
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(reply ?? {})),
        (error) => {
          console.error(`collector ${request.url} failed:`, error)
          response.writeHead(500).end()
        },
      )
    })
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(COLLECTOR_PORT, "127.0.0.1", () => resolve(server))
  })
}

// -------------------------------------------------------------------- check

/** One check run against a fresh server; returns the numbers, throws on failure. */
async function checkOnce(udid) {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-lab-expo-check-"))
  const server = startServer(dataDir)
  let control = null
  let collector = null
  try {
    await waitFor(() => discovery(dataDir) !== null, 30_000, "server.json")
    const { port } = discovery(dataDir)
    const token = readFileSync(join(dataDir, "server-token"), "utf8").trim()
    control = connect(port, token)

    const { sessionId } = await control.client.terminal.spawn.mutate({
      command: process.execPath,
      args: [PROGRAM, "stream"],
      cols: COLS,
      rows: ROWS,
    })
    // The program prints "R" once stdin is raw; a key sent before that is lost.
    const ready = readStream(control.client, sessionId, null)
    await waitFor(
      () =>
        Buffer.concat(ready.collected.bytes).includes("R") ||
        ready.collected.start?.screen.includes("R"),
      10_000,
      "the program to start",
    )
    ready.unsubscribe()

    let attached = null
    let reference = null
    let resultReceived = null
    const result = new Promise((resolve) => {
      resultReceived = resolve
    })
    const write = (data) => control.client.terminal.write.mutate({ sessionId, data })
    const trpcUrl = `ws://127.0.0.1:${port}/trpc?token=${encodeURIComponent(token)}`
    collector = await startCollector({
      "/config": () => ({ trpcUrl, sessionId, cols: COLS, rows: ROWS }),
      "/log": ({ line }) => console.log(`[app] ${line}`),
      "/attached": async (body) => {
        attached = body
        await write("g")
      },
      "/drop": async () => {
        const response = await fetch(`http://127.0.0.1:${port}/test/drop-connections`, {
          method: "POST",
          headers: { "x-pi-lab-token": token },
        })
        if (response.status !== 204) throw new Error(`drop-connections: HTTP ${response.status}`)
        console.log("dropped every client connection")
      },
      "/resumed": async () => {
        await sleep(200)
        await write("q")
        // The server's bytes from the app's first byte, read again on a new connection.
        const fresh = connect(port, token)
        const stream = readStream(fresh.client, sessionId, {
          ...attached.point,
          offset: attached.bytesFrom,
        })
        await waitFor(
          () =>
            stream.collected.error !== null ||
            (Buffer.concat(stream.collected.bytes).includes("FINAL") &&
              Date.now() - stream.collected.lastAt > 500),
          15_000,
          "the reference stream to reach FINAL",
        )
        stream.unsubscribe()
        fresh.close()
        reference = stream.collected
        if (reference.error) throw new Error(reference.error)
        return { endOffset: reference.end }
      },
      "/result": (body) => resultReceived(body),
    })
    spawnSyncQuiet(["terminate", udid, BUNDLE_ID])
    simctl(["launch", udid, BUNDLE_ID])

    let timer = null
    const report = await Promise.race([
      result,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "no result from the app within 90 s (see the app log: xcrun simctl spawn booted log show --last 5m --predicate 'process == \"PILabExpoCheck\"')",
              ),
            ),
          90_000,
        )
      }),
    ])
    clearTimeout(timer)
    return verify(report, attached, reference)
  } finally {
    if (control) {
      await control.client.server.stop
        .mutate({ stopAgents: true })
        .catch((error) => console.error("server.stop:", error.message))
      control.close()
    }
    collector?.close()
    const pid = discovery(dataDir)?.pid ?? server.pid
    await waitFor(() => !processAlive(pid), 15_000, "the server to stop").catch(() =>
      server.kill("SIGKILL"),
    )
    spawnSyncQuiet(["terminate", udid, BUNDLE_ID])
    rmSync(dataDir, { recursive: true, force: true })
  }
}

/** `simctl terminate` fails when the app is not running; that is fine. */
function spawnSyncQuiet(commandArgs) {
  try {
    execFileSync("xcrun", ["simctl", ...commandArgs], { env, stdio: "ignore" })
  } catch {
    // not running
  }
}

function verify(report, attached, reference) {
  const failures = []
  const expect = (condition, message) => {
    if (!condition) failures.push(message)
  }
  if (!report.ok) throw new Error(`app reported a failure: ${report.error}`)

  const offsetOf = (id) => Number(id?.split(":")[1])
  const resume = report.subscribeInputs[1]
  const lastReceived = offsetOf(report.lastReceivedAtSubscribe[1])
  const replay = report.received.find((event) => event.subscription === 2 && event.type === "start")
  expect(
    JSON.stringify(report.starts) === '["snapshot","replay"]',
    `start modes ${JSON.stringify(report.starts)}`,
  )
  expect(
    report.subscribeInputs.length === 2,
    `${report.subscribeInputs.length} subscriptions, expected 2`,
  )
  expect(report.subscribeInputs[0] === null, "the first subscription did not ask for a snapshot")
  expect(
    resume && resume.offset < lastReceived,
    `resume offset ${resume?.offset} is not before the last received id's offset ${lastReceived}`,
  )
  expect(
    replay && replay.offset === resume?.offset,
    `replay starts at ${replay?.offset}, resume asked ${resume?.offset}`,
  )

  // Every byte from the snapshot's first byte to the end applied exactly once, in order.
  let at = report.appliedStart
  for (const [start, end] of report.appliedRanges) {
    expect(start === at, `applied range ${start}-${end} after ${at} (gap or duplicate)`)
    at = end
  }
  expect(
    report.appliedStart === attached.bytesFrom,
    `applied from ${report.appliedStart}, snapshot bytes from ${attached.bytesFrom}`,
  )
  expect(at === reference.end, `applied up to ${at}, server stream ends at ${reference.end}`)
  const applied = Buffer.from(report.appliedBase64, "base64")
  const server = Buffer.concat(reference.bytes)
  expect(
    applied.length === at - report.appliedStart,
    `${applied.length} applied bytes for ${at - report.appliedStart} offsets`,
  )
  expect(
    applied.equals(server),
    `applied bytes differ from the server's (${applied.length} vs ${server.length} bytes)`,
  )

  // The numbered lines the app applied follow each other.
  const numbers = [...applied.toString("utf8").matchAll(/line (\d+) /g)].map((match) =>
    Number(match[1]),
  )
  const skipped = numbers.findIndex((value, index) => index > 0 && value !== numbers[index - 1] + 1)
  expect(
    numbers.length > 10 && skipped === -1,
    `line numbers not consecutive (at index ${skipped})`,
  )
  expect(applied.includes("FINAL"), "the app did not apply FINAL")
  expect(report.states.includes("reconnecting"), "the app never showed Reconnecting")
  expect(report.finalState === "connected", `the app ends ${report.finalState}`)

  const receivedAgain = report.received
    .filter(
      (event) =>
        event.subscription === 1 &&
        event.offset !== undefined &&
        event.offset + event.length > resume.offset,
    )
    .reduce(
      (sum, event) => sum + Math.min(event.length, event.offset + event.length - resume.offset),
      0,
    )
  const numbers_ = {
    snapshotBytesFrom: report.appliedStart,
    resumeOffset: resume?.offset,
    lastReceivedOffset: lastReceived,
    discardedThenReplayedBytes: receivedAgain,
    replayStartBytes: replay?.length,
    endOffset: at,
    appliedBytes: applied.length,
    lines: numbers.length,
    firstLine: numbers[0],
    lastLine: numbers.at(-1),
    starts: report.starts.join(","),
  }
  console.log("numbers:", JSON.stringify(numbers_))
  if (failures.length > 0) throw new Error(`check failed:\n- ${failures.join("\n- ")}`)
  return numbers_
}

// --------------------------------------------------------------------- main

if (!skipDesktopBuild) run("bun", ["run", "--cwd", DESKTOP, "build"])
if (!existsSync(SERVER_ENTRY)) throw new Error(`no built server at ${SERVER_ENTRY}`)
const udid = device()
bootDevice(udid)
if (!skipIosBuild) buildApp(udid)
simctl(["install", udid, appPath()])

const results = []
for (let index = 1; index <= runs; index++) {
  console.log(`\n=== run ${index} of ${runs} ===`)
  results.push(await checkOnce(udid))
}
console.log(`\nall ${runs} run(s) passed`)
for (const [index, numbers] of results.entries())
  console.log(`run ${index + 1}: ${JSON.stringify(numbers)}`)
process.exit(0)
