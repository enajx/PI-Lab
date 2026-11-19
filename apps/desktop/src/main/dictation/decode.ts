import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { AudioDecoder } from "./service"

const execFileAsync = promisify(execFile)
const AFCONVERT = "/usr/bin/afconvert"
const AFINFO = "/usr/bin/afinfo"

/**
 * A decoder that turns an m4a (AAC) or Ogg Opus recording into the 16 kHz mono
 * 16-bit WAV whisper.cpp reads, with macOS `afconvert`. Null on a machine
 * without it (Linux), where only WAV recordings can be transcribed.
 */
export function afconvertDecoder(): AudioDecoder | null {
  if (process.platform !== "darwin" || !existsSync(AFCONVERT)) return null
  return async (audio, format, maxSeconds) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-lab-dictation-"))
    const converted = await convertIn(dir, audio, format, maxSeconds)
    await rm(dir, { recursive: true, force: true })
    if (converted instanceof Error) throw converted
    return converted
  }
}

/**
 * Decode in `dir`: read the recording's length with `afinfo` and refuse one
 * longer than `maxSeconds` before converting (a few MB of low-bitrate audio
 * can be hours long), then check the WAV's size before reading it.
 */
async function convertIn(
  dir: string,
  audio: Buffer,
  format: string,
  maxSeconds: number,
): Promise<Buffer | Error> {
  const input = join(dir, `in.${format}`)
  const output = join(dir, "out.wav")
  await writeFile(input, audio)
  const failed = (error: { stderr?: string; message: string }) =>
    new Error(`Could not decode the ${format} recording: ${(error.stderr || error.message).trim()}`)
  const info = await execFileAsync(AFINFO, [input]).then(({ stdout }) => stdout, failed)
  if (info instanceof Error) return info
  const duration = /estimated duration: ([\d.]+) sec/.exec(info)
  if (duration === null) return new Error(`Could not read the length of the ${format} recording`)
  if (Number(duration[1]) > maxSeconds) return tooLong(maxSeconds)
  const done = await execFileAsync(AFCONVERT, [
    "-f",
    "WAVE",
    "-d",
    "LEI16@16000",
    "-c",
    "1",
    input,
    output,
  ]).then(() => null, failed)
  if (done instanceof Error) return done
  // One second over the limit for the WAV header and an estimated length.
  if ((await stat(output)).size > (maxSeconds + 1) * 32_000) return tooLong(maxSeconds)
  return readFile(output)
}

function tooLong(maxSeconds: number): Error {
  return new Error(`The recording is longer than ${maxSeconds} s, the most dictation takes`)
}

/** Wrap 16 kHz mono 16-bit little-endian PCM in a WAV header. */
export function pcm16kToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write("WAVEfmt ", 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16_000, 24)
  header.writeUInt32LE(32_000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
