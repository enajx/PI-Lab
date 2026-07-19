// Integration tests for the template router via createCallerFactory over a temp
// data dir (PI_LAB_DATA_DIR points at the harness temp). The writable template is
// seeded lazily from the bundled `apps/desktop/resources/template` (md/engineering/testing-and-build.md).
import { readFile } from "node:fs/promises"
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
  test("lazily seeds the writable template and lists its files (incl. the CLAUDE.md symlink)", async () => {
    // No explicit seed — the procedure seeds on first call.
    const entries = await h.caller.template.list()
    const names = entries.map((e) => e.name)

    expect(names).toContain("AGENTS.md")
    expect(names).toContain("CLAUDE.md") // a symlink → AGENTS.md, still listed
    expect(names).toContain("RESEARCH.md")
    expect(names).toContain("TODO.md")
    expect(entries.every((e) => e.kind === "file")).toBe(true)

    // The writable copy actually landed under the data dir.
    expect(resolveWritableTemplateDir()).toBe(join(h.dataDir, "template"))
  })
})

describe("template.read / write", () => {
  test("reads a seeded file and round-trips a write", async () => {
    const before = await h.caller.template.read({ relPath: "RESEARCH.md" })
    expect(before.exists).toBe(true)
    expect(before.content.length).toBeGreaterThan(0)

    const result = await h.caller.template.write({ relPath: "RESEARCH.md", content: "# edited\n" })
    expect(result.bytes).toBe(Buffer.byteLength("# edited\n", "utf8"))

    const after = await h.caller.template.read({ relPath: "RESEARCH.md" })
    expect(after.content).toBe("# edited\n")
    // The edit landed on disk in the writable copy, not the bundled original.
    expect(await readFile(join(h.dataDir, "template", "RESEARCH.md"), "utf8")).toBe("# edited\n")
  })

  test("a missing file reads as exists:false (not an error)", async () => {
    const result = await h.caller.template.read({ relPath: "NOPE.md" })
    expect(result).toEqual({ exists: false, content: "" })
  })

  test("writing CLAUDE.md writes through to its AGENTS.md symlink target", async () => {
    await h.caller.template.write({ relPath: "CLAUDE.md", content: "# through\n" })
    const agents = await h.caller.template.read({ relPath: "AGENTS.md" })
    expect(agents.content).toBe("# through\n")
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
