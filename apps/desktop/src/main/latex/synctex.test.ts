import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { afterEach, describe, expect, test } from "vitest"
import { forwardSync, reverseSync } from "./synctex"

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function fixture(
  engine: string,
  compressed: boolean,
): Promise<{ mapping: string; source: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-lab-synctex-test-"))
  temporaryDirectories.push(directory)
  const body = await readFile(
    new URL(`./__fixtures__/synctex/${engine}.synctex`, import.meta.url),
    "utf8",
  )
  const mapping = path.join(directory, compressed ? "main.synctex.gz" : "main.synctex")
  await writeFile(mapping, compressed ? gzipSync(body) : body)
  return { mapping, source: path.join(directory, "parts/chapter.tex") }
}

describe.each(["tectonic", "latexmk"])("%s real engine SyncTeX records", (engine) => {
  test.each([
    true,
    false,
  ])("finds an included source and reverse click, gzip=%s", async (compressed) => {
    const { mapping, source } = await fixture(engine, compressed)
    const target = await forwardSync(mapping, source, 2, 1)
    expect(target.page).toBe(2)
    // Checked against the system synctex CLI for these real output records.
    expect(target.x).toBeCloseTo(133.768, 2)
    expect(Math.abs(target.y - 146.72)).toBeLessThan(7)
    expect(await reverseSync(mapping, 2, 185, 146.72)).toEqual({
      sourceAbsolutePath: source,
      line: 2,
      column: 1,
    })
    expect(await reverseSync(mapping, target.page, target.x, target.y)).toEqual({
      sourceAbsolutePath: source,
      line: 2,
      column: 1,
    })
  })
})

test("resolves absolute input paths and replaces cached data after a rebuild", async () => {
  const { mapping, source } = await fixture("tectonic", false)
  const original = await readFile(mapping, "utf8")
  await writeFile(mapping, original.replace("./parts/chapter.tex", source))
  expect((await forwardSync(mapping, source, 2, 1)).page).toBe(2)
  await writeFile(mapping, original.replace("./parts/chapter.tex", `${source}.new`))
  await expect(forwardSync(mapping, source, 2, 1)).rejects.toThrow("No SyncTeX mapping")
})

test("rejects missing mappings, invalid positions and malformed data", async () => {
  const { mapping, source } = await fixture("tectonic", true)
  await expect(forwardSync(mapping, `${source}.missing`, 1, 1)).rejects.toThrow(
    "No SyncTeX mapping",
  )
  await expect(forwardSync(mapping, source, 0, 1)).rejects.toThrow("Invalid")
  await expect(reverseSync(mapping, 0, 2, 3)).rejects.toThrow("Invalid")
  await expect(reverseSync(mapping, 2, Number.NaN, 3)).rejects.toThrow("Invalid")
  await expect(reverseSync(mapping, 3, 2, 3)).rejects.toThrow("No SyncTeX mapping")
  await writeFile(mapping, gzipSync("not synctex"))
  await expect(forwardSync(mapping, source, 2, 1)).rejects.toThrow("Invalid SyncTeX")
})

test("bounds decompressed data", async () => {
  const { mapping, source } = await fixture("tectonic", true)
  await writeFile(mapping, gzipSync(Buffer.alloc(32 * 1024 * 1024 + 1, 32)))
  await expect(forwardSync(mapping, source, 2, 1)).rejects.toThrow()
})

test("handles scaled positions and signed offsets without opening source files", async () => {
  const { mapping, source } = await fixture("tectonic", false)
  const original = await forwardSync(mapping, source, 2, 1)
  const body = await readFile(mapping, "utf8")
  await writeFile(
    mapping,
    body
      .replace("Unit:1", "Unit:2")
      .replace("X Offset:0", "X Offset:-6578176")
      .replace("Y Offset:0", "Y Offset:6578176"),
  )
  const scaled = await forwardSync(mapping, source, 2, 1)
  expect(scaled.x).toBeCloseTo(2 * original.x - 100)
  expect(scaled.y).toBeCloseTo(2 * original.y + 100)
  expect(await reverseSync(mapping, scaled.page, scaled.x, scaled.y)).toEqual({
    sourceAbsolutePath: source,
    line: 2,
    column: 1,
  })
})

test("rejects integers outside the safe coordinate range", async () => {
  const { mapping, source } = await fixture("tectonic", false)
  const body = await readFile(mapping, "utf8")
  await writeFile(mapping, body.replace("8799519,9651487", "99999999999999999999,9651487"))
  await expect(forwardSync(mapping, source, 2, 1)).rejects.toThrow("Invalid SyncTeX coordinates")
})
