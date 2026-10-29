import { describe, expect, it } from "vitest"
import { anchorScroll, pdfStatusText, wheelZoom } from "./pdfZoom"

const wheel = (
  init: Partial<{ ctrlKey: boolean; shiftKey: boolean; deltaX: number; deltaY: number }>,
) => ({ ctrlKey: false, shiftKey: false, deltaX: 0, deltaY: 0, ...init })

describe("wheelZoom", () => {
  it("ignores a plain wheel so the pages scroll", () => {
    expect(wheelZoom(1, wheel({ deltaY: 40 }))).toBeNull()
  })

  it("zooms continuously on a pinch (ctrl + wheel)", () => {
    const zoomedIn = wheelZoom(1, wheel({ ctrlKey: true, deltaY: -10 }))
    const zoomedOut = wheelZoom(1, wheel({ ctrlKey: true, deltaY: 10 }))
    expect(zoomedIn).toBeGreaterThan(1)
    expect(zoomedIn).toBeLessThan(1.25)
    expect(zoomedOut).toBeLessThan(1)
    expect(zoomedOut).toBeGreaterThan(0.75)
  })

  it("steps through the presets with shift + wheel", () => {
    expect(wheelZoom(1, wheel({ shiftKey: true, deltaY: -100 }))).toBe(1.25)
    expect(wheelZoom(1, wheel({ shiftKey: true, deltaY: 100 }))).toBe(0.75)
    // Fit width usually lands between presets.
    expect(wheelZoom(1.1, wheel({ shiftKey: true, deltaY: -100 }))).toBe(1.25)
    expect(wheelZoom(1.1, wheel({ shiftKey: true, deltaY: 100 }))).toBe(1)
  })

  it("reads the shift + wheel direction from deltaX when macOS moves it there", () => {
    expect(wheelZoom(1, wheel({ shiftKey: true, deltaX: -100 }))).toBe(1.25)
    expect(wheelZoom(1, wheel({ shiftKey: true, deltaX: 100 }))).toBe(0.75)
  })

  it("clamps the zoom to 50%-300%", () => {
    expect(wheelZoom(3, wheel({ shiftKey: true, deltaY: -100 }))).toBe(3)
    expect(wheelZoom(0.5, wheel({ shiftKey: true, deltaY: 100 }))).toBe(0.5)
    expect(wheelZoom(2.9, wheel({ ctrlKey: true, deltaY: -500 }))).toBe(3)
    expect(wheelZoom(0.6, wheel({ ctrlKey: true, deltaY: 500 }))).toBe(0.5)
  })
})

describe("anchorScroll", () => {
  it("scrolls so the page point under the pointer stays under it after a zoom", () => {
    const pointer = { x: 300, y: 200 }
    // The pointer sits a quarter across and a fifth down the page.
    const before = { left: 200, top: 100, width: 400, height: 500 }
    // At twice the scale the same point would move to (400, 300).
    const after = { left: 200, top: 100, width: 800, height: 1000 }
    expect(anchorScroll(pointer, before, after)).toEqual({ left: 100, top: 100 })
  })

  it("scrolls back when zooming out, including for a page that moved", () => {
    const pointer = { x: 300, y: 200 }
    const before = { left: 100, top: -300, width: 800, height: 1000 }
    // Half the scale, and the centred page moved right by 150px.
    const after = { left: 250, top: -50, width: 400, height: 500 }
    // The point was at 25% / 50% of the page: now at (350, 200).
    expect(anchorScroll(pointer, before, after)).toEqual({ left: 50, top: 0 })
  })
})

describe("pdfStatusText", () => {
  it("shows the current page when the PDF is up to date", () => {
    expect(pdfStatusText(null, 2, 5)).toBe("Page 2 / 5")
  })

  it("appends the page to a transient state once the page count is known", () => {
    expect(pdfStatusText("Refreshing PDF…", 1, 2)).toBe("Refreshing PDF… · Page 1 / 2")
  })

  it("shows only the transient state before the page count is known", () => {
    expect(pdfStatusText("Loading PDF…", 1, 0)).toBe("Loading PDF…")
  })
})
