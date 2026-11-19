#!/usr/bin/env node
// Dictation benchmark for the phone app, against the test server of
// test-lab.mjs (data in $TMPDIR/pi-lab-mobile-test unless
// PI_LAB_MOBILE_TEST_ROOT is set). Needs macOS (`say`, `afconvert`) and
// ffmpeg with libopus (for the Ogg Opus clips). No microphone is used: the
// clips are synthetic speech made with `say`.
//
//   node apps/mobile/scripts/dictation-bench.mjs fixtures
//        make the clips (s5, s15, s45: about 5, 15 and 45 s) as 16 kHz mono
//        WAV, AAC m4a (32 kbps) and Ogg Opus (24 kbps), in the test project
//        python-research under .dictation-bench/
//   node apps/mobile/scripts/dictation-bench.mjs local --runs 3
//        on the Mac over loopback: model load (cold, only when the engine is
//        stopped) and warm transcription per clip and format
//   node apps/mobile/scripts/dictation-bench.mjs phone --device <adb serial> --runs 3
//        open the app's hidden benchmark screen on that device (explicit
//        intent), wait for it to finish, and print the median table from logcat

import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(HERE, "..", "..", "desktop")
const ROOT = process.env.PI_LAB_MOBILE_TEST_ROOT || join(tmpdir(), "pi-lab-mobile-test")
const DATA = join(ROOT, "data")
const PROJECT = "python-research"
const BENCH_DIR = ".dictation-bench"
const CLIPS = {
  s5: "[[rate 105]] Please refactor the tRPC router, then run the tests again.",
  s15: "[[rate 105]] Please refactor the tRPC router so the dictation procedure takes a format field. [[slnc 500]] Then update the Zod schema, run the vitest suite, and tell me which tests fail before you commit anything.",
  s45: "I want you to look at the server code for the phone app. [[slnc 500]] First, refactor the tRPC router so the dictation calls live in their own file, and give every input a Zod schema with an output schema as well. [[slnc 500]] Then check the WebSocket keep alive settings, because the phone drops the connection when it goes through Tailscale. [[slnc 500]] After that, run the type check with tsc for both the node and the web config, run biome on the files you touched, and run only the vitest cases for the dictation router. [[slnc 500]] When everything passes, write a short summary of what you changed in the pull request, and list any test that still fails, with the error it prints. [[slnc 500]] Do not commit or push anything yet, I will review the diff on my phone first.",
}
const FORMATS = ["wav", "m4a", "ogg"]
const APP_ACTIVITY = "dev.pilab.mobile/.MainActivity"

const desktopRequire = createRequire(join(DESKTOP, "package.json"))
const { createTRPCClient, createWSClient, wsLink } = desktopRequire("@trpc/client")

function connect() {
  const found = JSON.parse(readFileSync(join(DATA, "server.json"), "utf8"))
  const token = readFileSync(join(DATA, "server-token"), "utf8").trim()
  const ws = createWSClient({
    url: `ws://127.0.0.1:${found.port}/trpc?token=${encodeURIComponent(token)}`,
  })
  return { client: createTRPCClient({ links: [wsLink({ client: ws })] }), close: () => ws.close() }
}

function benchFolder() {
  return join(ROOT, "projects", PROJECT, BENCH_DIR)
}

function fixtures() {
  const dir = benchFolder()
  mkdirSync(dir, { recursive: true })
  for (const [clip, text] of Object.entries(CLIPS)) {
    const aiff = join(dir, `${clip}.aiff`)
    execFileSync("say", ["-o", aiff, text])
    const wav = join(dir, `${clip}.wav`)
    const ff = (args) =>
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args])
    ff(["-i", aiff, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav])
    ff(["-i", wav, "-c:a", "aac", "-b:a", "32k", join(dir, `${clip}.m4a`)])
    ff(["-i", wav, "-c:a", "libopus", "-b:a", "24k", join(dir, `${clip}.ogg`)])
    const seconds = (statSync(wav).size - 44) / 32000
    console.log(
      `${clip}: ${seconds.toFixed(1)} s; ${FORMATS.map((f) => `${f} ${statSync(join(dir, `${clip}.${f}`)).size} B`).join(", ")}`,
    )
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function local(runs) {
  const { client, close } = connect()
  const before = (await client.dictation.status.query()).engine.state
  const loadStart = performance.now()
  await client.dictation.prepare.mutate()
  const loadMs = Math.round(performance.now() - loadStart)
  console.log(
    before === "stopped"
      ? `cold model load (engine was stopped): ${loadMs} ms`
      : `engine was ${before}; prepare took ${loadMs} ms (not a cold load)`,
  )
  for (const clip of Object.keys(CLIPS)) {
    for (const format of FORMATS) {
      const audio = readFileSync(join(benchFolder(), `${clip}.${format}`))
      const rows = []
      for (let run = 0; run < runs; run += 1) {
        const started = performance.now()
        const result = await client.dictation.transcribeAudio.mutate({
          audioBase64: audio.toString("base64"),
          format,
        })
        rows.push({ ...result.timings, totalMs: performance.now() - started, text: result.text })
      }
      console.log(
        `${clip} ${format}: decode ${median(rows.map((r) => r.decodeMs))} ms, transcribe ${median(rows.map((r) => r.transcribeMs))} ms, total ${Math.round(median(rows.map((r) => r.totalMs)))} ms`,
      )
      console.log(`  text: ${rows[0].text}`)
    }
  }
  close()
}

async function phone(device, runs) {
  const adb = (args) => execFileSync("adb", ["-s", device, ...args], { encoding: "utf8" })
  const { client, close } = connect()
  const project = (await client.projects.list.query()).find((entry) => entry.name === PROJECT)
  if (!project) throw new Error(`no project named ${PROJECT}`)
  const workspace = (await client.workspaces.list.query({ projectId: project.id }))[0]
  if (!workspace) throw new Error(`project ${PROJECT} has no workspace`)
  close()
  const link = `pilab://dictation-bench?workspaceId=${workspace.id}&dir=${BENCH_DIR}&clips=${Object.keys(CLIPS).join(",")}&runs=${runs}`
  adb(["logcat", "-c"])
  adb([
    "shell",
    "am",
    "start",
    "-n",
    APP_ACTIVITY,
    "-a",
    "android.intent.action.VIEW",
    "-d",
    `'${link}'`,
  ])
  const rows = []
  for (let waited = 0; ; waited += 5) {
    await new Promise((resolve) => setTimeout(resolve, 5000))
    const log = adb(["logcat", "-d", "-s", "ReactNativeJS:V"])
    const failed = log.match(/DICTATION_BENCH_LOG FAILED: (.*)/)
    if (failed) throw new Error(`the benchmark failed on the phone: ${failed[1]}`)
    if (log.includes("DICTATION_BENCH_LOG DONE")) {
      for (const match of log.matchAll(/DICTATION_BENCH (\{.*\})/g)) rows.push(JSON.parse(match[1]))
      for (const match of log.matchAll(/DICTATION_BENCH_LOG ((RTT|prepare) .*)/g))
        console.log(match[1])
      break
    }
    if (waited > 1800) throw new Error("the benchmark did not finish in 30 minutes")
  }
  const groups = new Map()
  for (const row of rows) {
    const key = `${row.clip} ${row.method}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  console.log("clip method runs bytes phoneMs uploadMs decodeMs transcribeMs totalMs (medians)")
  for (const [key, group] of groups) {
    const m = (field) => median(group.map((row) => row[field]))
    console.log(
      `${key} ${group.length} ${m("bytes")} ${m("phoneMs")} ${m("uploadMs")} ${m("decodeMs")} ${m("transcribeMs")} ${m("totalMs")}`,
    )
    console.log(`  text: ${group[0].text}`)
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { values } = parseArgs({
    args: rest,
    options: { device: { type: "string" }, runs: { type: "string" } },
    strict: true,
  })
  const runs = Number(values.runs ?? "3")
  if (command === "fixtures") return fixtures()
  if (command === "local") return local(runs)
  if (command === "phone") {
    if (!values.device) throw new Error("phone needs --device")
    return phone(values.device, runs)
  }
  throw new Error(
    "usage: dictation-bench.mjs fixtures | local --runs N | phone --device SERIAL --runs N",
  )
}

await main()
