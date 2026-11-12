import { describe, expect, test } from "vitest"
import { fitPanelRow, type PanelRowInput } from "./panelFit"

/** Analysis: file list, preview and the right panel, saved at 300 / 500. */
function analysis(available: number, squeezeOpen: boolean, userCollapsed: boolean): PanelRowInput {
  return {
    available,
    side: { wanted: 300, min: 200 },
    main: { preferred: 256, min: 220 },
    panel: { wanted: 500, min: 300 },
    userCollapsed,
    squeezeOpen,
  }
}

describe("fitPanelRow", () => {
  test("with room, every part keeps its saved width", () => {
    expect(fitPanelRow(analysis(1400, false, false))).toEqual({
      open: true,
      forcedCollapsed: false,
      side: 300,
      panel: 500,
    })
  })

  test("the right panel shrinks first, down to its minimum", () => {
    // 300 + 12 + 256 + 12 + panel = 1000 -> panel 420.
    expect(fitPanelRow(analysis(1000, false, false))).toMatchObject({ side: 300, panel: 420 })
    // 300 + 256 + 300 + 24 = 880: the panel is at its minimum, the file list still saved.
    expect(fitPanelRow(analysis(880, false, false))).toMatchObject({ side: 300, panel: 300 })
  })

  test("then the file list shrinks, then the preview, before the panel collapses", () => {
    expect(fitPanelRow(analysis(830, false, false))).toMatchObject({
      open: true,
      side: 250,
      panel: 300,
    })
    // 200 + 220 + 300 + 24 = 744 is the smallest open layout.
    expect(fitPanelRow(analysis(744, false, false))).toMatchObject({
      open: true,
      side: 200,
      panel: 300,
    })
  })

  test("without room the panel is drawn collapsed, and the file list keeps what it can", () => {
    // Collapsed: side + 12 + main + 12 + 30.
    expect(fitPanelRow(analysis(700, false, false))).toEqual({
      open: false,
      forcedCollapsed: true,
      side: 300,
      panel: 0,
    })
    expect(fitPanelRow(analysis(500, false, false))).toMatchObject({ open: false, side: 200 })
  })

  test("expanding while short of room squeezes the others to their minimums", () => {
    // 700 - 24 - 200 - 220 = 256 is below the panel's minimum: the panel keeps 300.
    expect(fitPanelRow(analysis(700, true, false))).toEqual({
      open: true,
      forcedCollapsed: false,
      side: 200,
      panel: 300,
    })
  })

  test("a panel the user collapsed stays collapsed and is not counted as forced", () => {
    expect(fitPanelRow(analysis(1400, false, true))).toEqual({
      open: false,
      forcedCollapsed: false,
      side: 300,
      panel: 0,
    })
  })

  test("Tasks has no side column: the panel shrinks to its minimum, then collapses", () => {
    const tasks = (available: number): PanelRowInput => ({
      available,
      side: null,
      main: { preferred: 320, min: 320 },
      panel: { wanted: 500, min: 300 },
      userCollapsed: false,
      squeezeOpen: false,
    })
    expect(fitPanelRow(tasks(732))).toMatchObject({ open: true, panel: 400 })
    expect(fitPanelRow(tasks(632))).toMatchObject({ open: true, panel: 300 })
    expect(fitPanelRow(tasks(631))).toMatchObject({ open: false, forcedCollapsed: true })
  })

  test("an unmeasured row keeps the saved widths", () => {
    expect(fitPanelRow(analysis(Number.POSITIVE_INFINITY, false, false))).toMatchObject({
      open: true,
      side: 300,
      panel: 500,
    })
  })
})
