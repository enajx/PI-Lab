// Hidden debug screen: the dictation benchmark. Opened only by an explicit
// intent from the Mac (apps/mobile/scripts/dictation-bench.mjs), never from
// the app's own screens. It downloads fixed clips from the server (no
// microphone), then times, per clip and way of sending, the path from "the
// user stopped speaking" to "the text is back": phone-side work, upload, the
// server's decode and transcription. Each result row is logged to logcat as
// `DICTATION_BENCH {json}` and shown on screen.

import { File, Paths, UploadType } from "expo-file-system"
import { useEffect, useState } from "react"
import { ScrollView, StyleSheet, Text } from "react-native"
import { type Client, useConnection } from "../connection"
import { endpointFor } from "../logic/address"
import { bytesToBase64 } from "../logic/pcm"
import { colors, mono } from "../theme"

export interface BenchParams {
  workspaceId: string
  /** Folder in the workspace that holds `<clip>.<format>` files. */
  dir: string
  clips: string[]
  runs: number
}

type Format = "wav" | "m4a" | "ogg"
type Method = `${Format}-trpc` | `${Format}-http` | "pcm-stream"

interface Row {
  clip: string
  method: Method
  run: number
  bytes: number
  phoneMs: number
  uploadMs: number
  decodeMs: number
  transcribeMs: number
  totalMs: number
  text: string
}

const FORMATS: Format[] = ["wav", "m4a", "ogg"]
/** 250 ms of 16 kHz mono 16-bit PCM. */
const CHUNK_BYTES = 8000
const CHUNK_MS = 250
const WAV_HEADER_BYTES = 44
const TOKEN_HEADER = "x-pi-lab-token"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Parse `pilab://dictation-bench?workspaceId=..&dir=..&clips=a,b&runs=3`; null for any other URL. */
export function parseBenchLink(url: string | null): BenchParams | null {
  if (!url?.startsWith("pilab://dictation-bench?")) return null
  const query = new Map<string, string>()
  for (const pair of url.slice("pilab://dictation-bench?".length).split("&")) {
    const equals = pair.indexOf("=")
    if (equals > 0) query.set(pair.slice(0, equals), decodeURIComponent(pair.slice(equals + 1)))
  }
  const workspaceId = query.get("workspaceId")
  const dir = query.get("dir")
  const clips = query.get("clips")
  if (!workspaceId || !dir || !clips) return null
  return { workspaceId, dir, clips: clips.split(","), runs: Number(query.get("runs") ?? "3") }
}

export function DictationBenchScreen({ params }: { params: BenchParams }) {
  const { connection, phase } = useConnection()
  const [lines, setLines] = useState<string[]>(["Waiting for the connection"])
  const login = phase.kind === "online" ? phase.login : null

  useEffect(() => {
    if (!connection || !login) return
    const say = (line: string) => {
      console.log(`DICTATION_BENCH_LOG ${line}`)
      setLines((current) => [...current, line])
    }
    void runBench(
      connection.client,
      endpointFor(login.address, login.token).httpUrl,
      login.token,
      params,
      say,
    ).then(
      () => say("DONE"),
      (error: unknown) => say(`FAILED: ${error instanceof Error ? error.message : String(error)}`),
    )
  }, [connection, login, params])

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 16, paddingTop: 48 }}>
      <Text style={styles.title}>Dictation benchmark</Text>
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the lines only grow at the end.
        <Text key={`${index}-${line}`} style={styles.line}>
          {line}
        </Text>
      ))}
    </ScrollView>
  )
}

async function runBench(
  client: Client,
  httpUrl: string,
  token: string,
  params: BenchParams,
  say: (line: string) => void,
): Promise<void> {
  // The sockets may still be opening when the screen starts.
  for (let tries = 0; ; tries += 1) {
    const ready = await client.server.hello.query().then(
      () => true,
      (error: unknown) => {
        if (tries >= 30) throw error
        return false
      },
    )
    if (ready) break
    await sleep(1000)
  }
  const rtts: number[] = []
  for (let i = 0; i < 7; i += 1) {
    const started = performance.now()
    await client.server.hello.query()
    rtts.push(performance.now() - started)
  }
  say(`RTT ${JSON.stringify({ medianMs: median(rtts), allMs: rtts.map(Math.round) })}`)
  const prepared = await client.dictation.prepare.mutate()
  say(`prepare ${JSON.stringify(prepared)}`)
  const files = new Map<string, File>()
  for (const clip of params.clips) {
    for (const format of FORMATS) {
      const name = `${clip}.${format}`
      const relPath = `${params.dir}/${name}`
      const url = `${httpUrl}/files/download?workspaceId=${encodeURIComponent(params.workspaceId)}&relPath=${encodeURIComponent(relPath)}`
      const file = await File.downloadFileAsync(url, new File(Paths.cache, `bench-${name}`), {
        headers: { [TOKEN_HEADER]: token },
        idempotent: true,
      })
      files.set(name, file)
    }
  }
  say(`downloaded ${files.size} clips`)
  const methods: Method[] = [
    "wav-trpc",
    "m4a-trpc",
    "ogg-trpc",
    "wav-http",
    "m4a-http",
    "ogg-http",
    "pcm-stream",
  ]
  for (const clip of params.clips) {
    for (let run = 1; run <= params.runs; run += 1) {
      for (const method of methods) {
        const row = await measure(client, httpUrl, token, files, clip, method, run)
        console.log(`DICTATION_BENCH ${JSON.stringify(row)}`)
        say(
          `${clip} ${method} #${run}: ${row.bytes} B, phone ${row.phoneMs}, up ${row.uploadMs}, dec ${row.decodeMs}, asr ${row.transcribeMs}, total ${row.totalMs} ms`,
        )
      }
    }
  }
}

function fileFor(files: Map<string, File>, name: string): File {
  const file = files.get(name)
  if (!file) throw new Error(`no downloaded clip ${name}`)
  return file
}

/** One timed run; "stop" is the moment the recording would end. */
async function measure(
  client: Client,
  httpUrl: string,
  token: string,
  files: Map<string, File>,
  clip: string,
  method: Method,
  run: number,
): Promise<Row> {
  if (method === "pcm-stream")
    return measureStream(client, fileFor(files, `${clip}.wav`), clip, run)
  const format = method.slice(0, 3) as Format
  const file = fileFor(files, `${clip}.${format}`)
  const stopped = performance.now()
  if (method.endsWith("-trpc")) {
    const audioBase64 = await file.base64()
    const phoneMs = performance.now() - stopped
    const result = await client.dictation.transcribeAudio.mutate({ audioBase64, format })
    return row(clip, method, run, file.size, phoneMs, stopped, result)
  }
  const uploaded = await file.upload(`${httpUrl}/dictation/transcribe?format=${format}`, {
    httpMethod: "POST",
    uploadType: UploadType.BINARY_CONTENT,
    headers: { [TOKEN_HEADER]: token, "content-type": "application/octet-stream" },
  })
  if (uploaded.status !== 200) throw new Error(`HTTP ${uploaded.status}: ${uploaded.body}`)
  return row(clip, method, run, file.size, 0, stopped, JSON.parse(uploaded.body))
}

/**
 * Simulated live recording: the clip's PCM is sent in 250 ms chunks at the
 * pace a microphone would deliver them, each append awaited in order; at
 * "stop" the last chunk goes with finish. Timed from stop.
 */
async function measureStream(client: Client, wav: File, clip: string, run: number): Promise<Row> {
  const pcm = (await wav.bytes()).subarray(WAV_HEADER_BYTES)
  const { streamId } = await client.dictation.stream.start.mutate()
  const chunkCount = Math.ceil(pcm.length / CHUNK_BYTES)
  const begun = performance.now()
  let queue: Promise<void> = Promise.resolve()
  for (let seq = 0; seq < chunkCount - 1; seq += 1) {
    await sleep(Math.max(0, begun + (seq + 1) * CHUNK_MS - performance.now()))
    const bytes = pcm.subarray(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES)
    queue = queue.then(() =>
      client.dictation.stream.append.mutate({ streamId, seq, pcmBase64: bytesToBase64(bytes) }),
    )
  }
  await sleep(Math.max(0, begun + chunkCount * CHUNK_MS - performance.now()))
  const stopped = performance.now()
  const last = pcm.subarray((chunkCount - 1) * CHUNK_BYTES)
  await queue
  const result = await client.dictation.stream.finish.mutate({
    streamId,
    seq: chunkCount - 1,
    pcmBase64: bytesToBase64(last),
  })
  return row(clip, "pcm-stream", run, last.length, 0, stopped, result)
}

function row(
  clip: string,
  method: Method,
  run: number,
  bytes: number,
  phoneMs: number,
  stopped: number,
  result: { text: string; timings: { decodeMs: number; transcribeMs: number } },
): Row {
  const totalMs = Math.round(performance.now() - stopped)
  const { decodeMs, transcribeMs } = result.timings
  return {
    clip,
    method,
    run,
    bytes,
    phoneMs: Math.round(phoneMs),
    uploadMs: Math.round(totalMs - phoneMs - decodeMs - transcribeMs),
    decodeMs,
    transcribeMs,
    totalMs,
    text: result.text,
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0)
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  title: { color: colors.text, fontSize: 18, fontWeight: "600", marginBottom: 12 },
  line: { color: colors.muted, fontFamily: mono, fontSize: 11, lineHeight: 15 },
})
