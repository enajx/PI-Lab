import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { afconvertDecoder } from "./decode"

// Real boundary: macOS afinfo and afconvert on an m4a made with `say`. Nothing is mocked.
const decoder = afconvertDecoder()

test.skipIf(decoder === null)(
  "decodes an m4a within the length limit and refuses one longer than it before converting",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-lab-decode-test-"))
    const aiff = join(dir, "speech.aiff")
    const m4a = join(dir, "speech.m4a")
    execFileSync("/usr/bin/say", ["-o", aiff, "Run the tests and report back"])
    execFileSync("/usr/bin/afconvert", ["-f", "m4af", "-d", "aac", "-b", "32000", aiff, m4a])
    const audio = readFileSync(m4a)
    const decode = decoder ?? (() => Promise.reject(new Error("no decoder")))

    const wav = await decode(audio, "m4a", 600)
    expect(wav.subarray(0, 4).toString()).toBe("RIFF")
    expect(wav.length).toBeGreaterThan(16_000)
    await expect(decode(audio, "m4a", 1)).rejects.toThrow(
      "The recording is longer than 1 s, the most dictation takes",
    )
    await rm(dir, { recursive: true, force: true })
  },
)
