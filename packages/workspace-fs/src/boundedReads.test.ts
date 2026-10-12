import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import * as fs from "./fs"

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bounded-reads-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test("editor accepts exactly 10 MB and rejects one extra byte without content", async () => {
  const path = join(root, "large.txt")
  await writeFile(path, "x".repeat(10_000_000))
  const exact = await fs.readTextSnapshot(path)
  expect(exact.status).toBe("text")
  if (exact.status === "text") expect(exact.content.length).toBe(10_000_000)
  await writeFile(path, "x".repeat(10_000_001))
  const over = await fs.readTextSnapshot(path)
  expect(over).toMatchObject({ status: "oversized", size: 10_000_001, limit: 10_000_000 })
  expect(over).not.toHaveProperty("content")
})

test.each([
  Buffer.from([0, 65]),
  Buffer.from([0xc3, 0x28]),
])("binary bytes never enter editable text: %j", async (bytes) => {
  const path = join(root, "binary")
  await writeFile(path, bytes)
  const result = await fs.readTextSnapshot(path)
  expect(result).toMatchObject({ status: "binary", size: bytes.length })
  expect(result).not.toHaveProperty("content")
})

test("valid UTF-8 preserves BOM and multibyte content", async () => {
  const path = join(root, "utf8")
  await writeFile(path, "\uFEFFæ😀\n")
  expect(await fs.readTextSnapshot(path)).toMatchObject({ status: "text", content: "\uFEFFæ😀\n" })
})

test("save verification compares text larger than the editor cap without echoing it", async () => {
  const path = join(root, "saved.txt")
  const content = `${"a".repeat(10_000_000)}😀\uFEFF`
  await fs.writeTextFile(path, content)
  const result = await fs.verifyWrittenText(path, content)
  expect(result).toMatchObject({
    matchesWrittenContent: true,
    baseline: { size: Buffer.byteLength(content) },
  })
  expect(result).not.toHaveProperty("content")
  expect(await readFile(path, "utf8")).toBe(content)
  expect(await fs.verifyWrittenText(path, `${content.slice(0, -1)}x`)).toMatchObject({
    matchesWrittenContent: false,
  })
})

test("save verification preserves UTF-8 across chunk boundaries and rejects altered lengths", async () => {
  const path = join(root, "chunks")
  const content = `${"x".repeat(65_535)}😀æ${"y".repeat(65_535)}終`
  await fs.writeTextFile(path, content)
  expect((await fs.verifyWrittenText(path, content)).matchesWrittenContent).toBe(true)
  await fs.writeTextFile(path, `${content}x`)
  expect((await fs.verifyWrittenText(path, content)).matchesWrittenContent).toBe(false)
  await fs.writeTextFile(path, content.slice(0, -1))
  expect((await fs.verifyWrittenText(path, content)).matchesWrittenContent).toBe(false)
  const invalid = "unpaired \ud800"
  await fs.writeTextFile(path, invalid)
  expect((await fs.verifyWrittenText(path, invalid)).matchesWrittenContent).toBe(false)
})
