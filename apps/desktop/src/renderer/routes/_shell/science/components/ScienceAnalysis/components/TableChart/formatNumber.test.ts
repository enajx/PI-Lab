import { describe, expect, test } from "vitest"
import { formatNumber } from "./formatNumber"

describe("formatNumber", () => {
  test("auto keeps up to 6 significant digits", () => {
    expect(formatNumber("1.13012144420843e-06", { decimals: null, scientific: false })).toBe(
      "0.00000113012",
    )
    expect(formatNumber("0.1415094339", { decimals: null, scientific: false })).toBe("0.141509")
  })

  test("decimal places and scientific notation", () => {
    expect(formatNumber("0.1415094339", { decimals: 2, scientific: false })).toBe("0.14")
    expect(formatNumber("0.000123", { decimals: 2, scientific: true })).toBe("1.23e-4")
  })

  test("blanks and text stay as they are", () => {
    expect(formatNumber("", { decimals: 2, scientific: false })).toBe("")
    expect(formatNumber("nan", { decimals: 2, scientific: false })).toBe("nan")
  })
})
