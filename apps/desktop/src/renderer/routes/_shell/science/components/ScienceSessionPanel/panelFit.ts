/** The gap between cards. A collapsed right panel takes no width and no gap. */
export const CARD_GAP = 12

/** The narrowest the right panel, the Analysis file list, the preview and the Tasks board are drawn. */
export const PANEL_DRAWN_MIN_WIDTH = 200
export const ANALYSIS_FILES_DRAWN_MIN_WIDTH = 200
export const ANALYSIS_PREVIEW_PREFERRED_WIDTH = 256
export const ANALYSIS_PREVIEW_MIN_WIDTH = 220
export const TASKS_BOARD_MIN_WIDTH = 320
/** The LaTeX Editor's editor card: the diary narrows before it goes below the preferred width. */
export const LATEX_EDITOR_PREFERRED_WIDTH = 480
export const LATEX_EDITOR_MIN_WIDTH = 360

/** A row of cards: an optional side column, the main card (flexible) and the right panel. */
export interface PanelRowInput {
  /** Width of the row in px; `Infinity` while it is not measured yet. */
  available: number
  /** The left column (Analysis file list) at its saved width, or null (Tasks). */
  side: { wanted: number; min: number } | null
  /** The main card: it gives up space down to `preferred` before the others shrink, and to `min` last. */
  main: { preferred: number; min: number }
  /** The right panel at its saved width. */
  panel: { wanted: number; min: number }
  /** The user's collapsed choice. */
  userCollapsed: boolean
  /** The user opened the panel while it was collapsed for lack of room. */
  squeezeOpen: boolean
}

/** Drawn widths: `panel` is 0 while the panel is drawn collapsed. */
export interface PanelRowFit {
  open: boolean
  /** Drawn collapsed only because there is no room (the saved choice is open). */
  forcedCollapsed: boolean
  side: number
  panel: number
}

/**
 * Fit the row in its width without horizontal scrolling. While space runs short
 * the main card first gives up its slack down to its preferred width, then the
 * right panel shrinks to its minimum, then the side column, then the main card
 * to its minimum. If it still does not fit, the panel is drawn collapsed (its saved
 * choice is kept), unless the user opened it then: the others are drawn at their
 * minimums and the panel is drawn at its own minimum (the main card then goes
 * below its minimum). Saved widths are never changed here.
 */
export function fitPanelRow(input: PanelRowInput): PanelRowFit {
  const { side, main, panel } = input
  const sideWanted = side?.wanted ?? 0
  const sideMin = side?.min ?? 0
  const gaps = (side ? 2 : 1) * CARD_GAP
  const collapsed = (forcedCollapsed: boolean): PanelRowFit => {
    const room = input.available - (side ? CARD_GAP : 0)
    const sideWidth = Math.max(sideMin, Math.min(sideWanted, room - main.preferred))
    return { open: false, forcedCollapsed, side: sideWidth, panel: 0 }
  }
  if (input.userCollapsed) return collapsed(false)

  const room = input.available - gaps
  let deficit = main.preferred - (room - sideWanted - panel.wanted)
  const panelCut = Math.min(Math.max(deficit, 0), panel.wanted - panel.min)
  deficit -= panelCut
  const sideCut = Math.min(Math.max(deficit, 0), sideWanted - sideMin)
  const panelWidth = panel.wanted - panelCut
  const sideWidth = sideWanted - sideCut
  if (room - sideWidth - panelWidth >= main.min) {
    return { open: true, forcedCollapsed: false, side: sideWidth, panel: panelWidth }
  }
  if (input.squeezeOpen) {
    // There is less than the panel's minimum left for it (else the row would fit), so
    // the panel the user opened keeps its minimum and its toolbar stays whole; the
    // main card gets what is left, below its minimum.
    return {
      open: true,
      forcedCollapsed: false,
      side: sideMin,
      panel: panel.min,
    }
  }
  return collapsed(true)
}
