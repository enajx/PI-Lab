import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { MAX_EDITOR_THEME_BYTES, readEditorThemeFiles } from "./themeImport"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("readEditorThemeFiles", () => {
  test("bounded-reads multiple JSON themes and returns no external paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-theme-"))
    dirs.push(dir)
    const first = join(dir, "First.json")
    const second = join(dir, "Second.json")
    await writeFile(
      first,
      JSON.stringify({
        name: "First",
        type: "dark",
        colors: { "editor.background": "#111", "editor.foreground": "#eee" },
      }),
    )
    await writeFile(
      second,
      JSON.stringify({
        name: "Second",
        type: "light",
        colors: { "editor.background": "#fff", "editor.foreground": "#111" },
      }),
    )

    const result = await readEditorThemeFiles([first, second])
    expect(result.themes.map((theme) => theme.name)).toEqual(["First", "Second"])
    expect(result.errors).toEqual([])
    expect(JSON.stringify(result)).not.toContain(dir)
  })

  test("reports invalid and oversized files without hiding valid imports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-theme-"))
    dirs.push(dir)
    const valid = join(dir, "valid.json")
    const invalid = join(dir, "invalid.json")
    const huge = join(dir, "huge.json")
    await writeFile(
      valid,
      JSON.stringify({
        colors: { "editor.background": "#111", "editor.foreground": "#eee" },
      }),
    )
    await writeFile(invalid, "{")
    await writeFile(huge, "x".repeat(MAX_EDITOR_THEME_BYTES + 1))

    const result = await readEditorThemeFiles([invalid, valid, huge])
    expect(result.themes).toHaveLength(1)
    expect(result.errors).toEqual([
      expect.objectContaining({
        filename: "invalid.json",
        message: expect.stringContaining("JSON"),
      }),
      expect.objectContaining({ filename: "huge.json", message: expect.stringContaining("large") }),
    ])
  })
})
