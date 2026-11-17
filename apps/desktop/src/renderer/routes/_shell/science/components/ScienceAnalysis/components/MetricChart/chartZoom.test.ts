import { describe, expect, test } from "vitest"
import { countInRange, rangeOf, xAtPixel, zoomInRange, zoomOutRange } from "./chartZoom"

describe("chart zoom ranges", () => {
  test("zoom in keeps the middle half of the range", () => {
    expect(zoomInRange({ min: 0, max: 100 })).toEqual({ min: 25, max: 75 })
  })

  test("zoom out doubles the range around its centre", () => {
    expect(zoomOutRange({ min: 40, max: 60 }, { min: 0, max: 100 })).toEqual({ min: 30, max: 70 })
  })

  test("zoom out is moved back inside the full range at an edge", () => {
    expect(zoomOutRange({ min: 0, max: 20 }, { min: 0, max: 100 })).toEqual({ min: 0, max: 40 })
    expect(zoomOutRange({ min: 90, max: 100 }, { min: 0, max: 100 })).toEqual({ min: 80, max: 100 })
  })

  test("zoom out never goes past the full range", () => {
    expect(zoomOutRange({ min: 20, max: 80 }, { min: 0, max: 100 })).toEqual({ min: 0, max: 100 })
  })

  test("a mouse pixel maps to an x value, clamped to the plot area", () => {
    const view = { min: 10, max: 20 }
    expect(xAtPixel(60, 60, 160, view)).toBe(10)
    expect(xAtPixel(110, 60, 160, view)).toBe(15)
    expect(xAtPixel(500, 60, 160, view)).toBe(20)
    expect(xAtPixel(0, 60, 160, view)).toBe(10)
  })

  test("range and point counts skip non-finite values", () => {
    expect(rangeOf([3, Number.NaN, -1, 7])).toEqual({ min: -1, max: 7 })
    expect(rangeOf([])).toBeNull()
    expect(countInRange([0, 1, 2, 3, 4], { min: 1, max: 3 })).toBe(3)
  })
})
