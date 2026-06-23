import { describe, expect, test } from "vitest"
import { extensionOf, languageForPath } from "./languageForPath"

describe("extensionOf", () => {
  test("returns the lower-cased final extension", () => {
    expect(extensionOf("main.PY")).toBe("py")
    expect(extensionOf("src/lib/util.py")).toBe("py")
  })

  test("returns '' for a path with no extension", () => {
    expect(extensionOf("Makefile")).toBe("")
    expect(extensionOf("src/README")).toBe("")
  })

  test("treats a leading dot as a dotfile, not an extension", () => {
    expect(extensionOf(".gitignore")).toBe("")
    expect(extensionOf("src/.env")).toBe("")
  })

  test("uses only the final segment's extension", () => {
    expect(extensionOf("a.b/c.py")).toBe("py")
    expect(extensionOf("archive.tar/file")).toBe("")
  })
})

describe("languageForPath", () => {
  test("returns a Python extension for .py and friends", () => {
    expect(languageForPath("main.py")).not.toBeNull()
    expect(languageForPath("stub.pyi")).not.toBeNull()
    expect(languageForPath("win.pyw")).not.toBeNull()
  })

  test("returns null for non-Python files (plain text in v1)", () => {
    expect(languageForPath("notes.md")).toBeNull()
    expect(languageForPath("app.ts")).toBeNull()
    expect(languageForPath("data.json")).toBeNull()
    expect(languageForPath("Makefile")).toBeNull()
  })
})
