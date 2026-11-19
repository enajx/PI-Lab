import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { AudioDecoder } from "./service"

const execFileAsync = promisify(execFile)
const AFCONVERT = "/usr/bin/afconvert"

/**
 * A decoder that turns an m4a (AAC) or Ogg Opus recording into the 16 kHz mono
 * 16-bit WAV whisper.cpp reads, with macOS `afconvert`. Null on a machine
 * without it (Linux), where only WAV recordings can be transcribed.
 */
export function afconvertDecoder(): AudioDecoder | null {
  if (process.platform !== "darwin" || !existsSync(AFCONVERT)) return null
  return async (audio, format) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-lab-dictation-"))
    const input = join(dir, `in.${format}`)
    const output = join(dir, "out.wav")
    await writeFile(input, audio)
    const converted = await execFileAsync(AFCONVERT, [
      "-f",
      "WAVE",
      "-d",
      "LEI16@16000",
      "-c",
      "1",
      input,
      output,
    ]).then(
      () => readFile(output),
      (error: { stderr?: string; message: string }) => error,
    )
    await rm(dir, { recursive: true, force: true })
    if (!Buffer.isBuffer(converted))
      throw new Error(
        `Could not decode the ${format} recording: ${(converted.stderr || converted.message).trim()}`,
      )
    return converted
  }
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
