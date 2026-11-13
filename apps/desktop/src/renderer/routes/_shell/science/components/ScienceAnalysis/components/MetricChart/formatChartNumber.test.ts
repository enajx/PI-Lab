import { describe, expect, test } from "vitest"
import { formatChartNumber } from "./formatChartNumber"

describe("formatChartNumber", () => {
  test.each([
    [0.045454545454545456, "0.04545"],
    [21, "21"],
    [-3, "-3"],
    [0, "0"],
    [1.5, "1.5"],
    [123.456, "123.5"],
    [0.001, "0.001"],
    [0.000001234, "1.234e-6"],
    [320_000_000, "3.2e+8"],
    [999_999, "999999"],
    [1_234_567.8, "1.235e+6"],
    [Number.NaN, "NaN"],
  ])("%s → %s", (value, expected) => {
    expect(formatChartNumber(value)).toBe(expected)
  })
})
