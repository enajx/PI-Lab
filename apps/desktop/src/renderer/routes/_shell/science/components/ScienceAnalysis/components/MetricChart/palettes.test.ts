import { describe, expect, test } from "vitest"
import { DEFAULT_PALETTE, paletteColor } from "./palettes"

describe("paletteColor", () => {
  test("qualitative maps repeat their colors", () => {
    expect(paletteColor("tab10", 0, 3)).toBe("#1f77b4")
    expect(paletteColor("tab10", 10, 12)).toBe("#1f77b4")
  })

  test("sequential maps run from the first to the last stop", () => {
    expect(paletteColor("viridis", 0, 3)).toBe("rgb(68, 1, 84)")
    expect(paletteColor("viridis", 2, 3)).toBe("rgb(253, 231, 37)")
    expect(paletteColor("viridis", 0, 1)).toBe("rgb(33, 145, 140)")
  })

  test("an unknown id gives the default colors", () => {
    expect(paletteColor("nope", 0, 1)).toBe(paletteColor(DEFAULT_PALETTE, 0, 1))
  })
})
