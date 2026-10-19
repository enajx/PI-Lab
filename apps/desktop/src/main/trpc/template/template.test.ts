// Integration tests for the template router via createCallerFactory over a temp
// data dir (PI_LAB_DATA_DIR points at the harness temp). The writable template
// starts empty and can be edited or filled through the import action.
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createHarness, type Harness } from "../testHarness"
import { resolveWritableTemplateDir } from "./templateDir"

let h: Harness

beforeEach(async () => {
  h = await createHarness()
})

afterEach(async () => {
  await h.dispose()
})

describe("template.list", () => {
  test("lazily creates an empty writable template", async () => {
    const entries = await h.caller.template.list()
    expect(entries).toEqual([])

    // The writable copy actually landed under the data dir.
    expect(resolveWritableTemplateDir()).toBe(join(h.dataDir, "template"))
  })
})

describe("template.read / write", () => {
  test("writes a new file and reads it back", async () => {
    const before = await h.caller.template.read({ relPath: "RESEARCH.md" })
    expect(before).toEqual({ exists: false, content: "" })

    const result = await h.caller.template.write({ relPath: "RESEARCH.md", content: "# edited\n" })
    expect(result.bytes).toBe(Buffer.byteLength("# edited\n", "utf8"))

    const after = await h.caller.template.read({ relPath: "RESEARCH.md" })
    expect(after.content).toBe("# edited\n")
    // The edit landed on disk in the writable template.
    expect(await readFile(join(h.dataDir, "template", "RESEARCH.md"), "utf8")).toBe("# edited\n")
  })

  test("a missing file reads as exists:false (not an error)", async () => {
    const result = await h.caller.template.read({ relPath: "NOPE.md" })
    expect(result).toEqual({ exists: false, content: "" })
  })

  test("the writable template lists a file after it is added", async () => {
    await h.caller.template.write({ relPath: "AGENTS.md", content: "# Instructions\n" })
    expect(await h.caller.template.list()).toContainEqual({
      name: "AGENTS.md",
      relPath: "AGENTS.md",
      kind: "file",
    })
  })
})

describe("template.import / remove", () => {
  test("imports an external ordinary file by name into the writable template", async () => {
    const source = join(h.dataDir, "incoming.txt")
    await writeFile(source, "Imported\n", "utf8")

    await expect(h.caller.template.import({ sourcePath: source })).resolves.toEqual({
      name: "incoming.txt",
      relPath: "incoming.txt",
      kind: "file",
    })
    expect(await readFile(join(h.dataDir, "template", "incoming.txt"), "utf8")).toBe("Imported\n")
  })

  test("removes an imported template file", async () => {
    const source = join(h.dataDir, "remove-me.txt")
    await writeFile(source, "Remove\n", "utf8")
    await h.caller.template.import({ sourcePath: source })
    await expect(h.caller.template.remove({ relPath: "remove-me.txt" })).resolves.toEqual({
      relPath: "remove-me.txt",
    })
    await expect(
      readFile(join(h.dataDir, "template", "remove-me.txt"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
})

describe("template path-jail", () => {
  test("an absolute path is FORBIDDEN", async () => {
    await expect(h.caller.template.read({ relPath: "/etc/passwd" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })

  test("a parent-escape path is FORBIDDEN on read and write", async () => {
    await expect(h.caller.template.read({ relPath: "../local.db" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(
      h.caller.template.write({ relPath: "../escape.txt", content: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})
