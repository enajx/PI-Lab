import { describe, expect, test } from "vitest"
import { translateKnownError } from "./errors"

describe("known PI Lab errors", () => {
  test("translates a document validation error and preserves its path", () => {
    expect(translateKnownError("es", "Markdown file not found: notes/Plan.md")).toBe(
      "No se encontró el archivo Markdown: notes/Plan.md",
    )
  })

  test("preserves external diagnostic text", () => {
    expect(translateKnownError("es", "Git failed: remote rejected")).toBe(
      "Git failed: remote rejected",
    )
  })
})
