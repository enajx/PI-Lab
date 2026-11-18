import type { IDecoration, IMarker, ITheme, Terminal as XTerm } from "@xterm/xterm"
import type { PredictionEngine, PredictionScreen, PredictionView } from "./localEcho"

/** Class of each drawn prediction element (tests look for it). */
export const PREDICTION_CLASS = "pi-lab-prediction"
/** Class of the predicted cursor element. */
export const PREDICTED_CURSOR_CLASS = "pi-lab-predicted-cursor"

/**
 * Draws local echo predictions over xterm as decorations: one per predicted
 * cell, painted with the terminal background so it covers the real cell, and
 * a predicted cursor. While the predicted cursor shows, xterm's own cursor is
 * made transparent through the theme. Nothing is written into xterm, so its
 * screen always holds only the daemon's bytes.
 */
export class LocalEchoOverlay {
  readonly #xterm: XTerm
  readonly #engine: PredictionEngine
  readonly #theme: () => ITheme
  #drawn: { marker: IMarker; decoration: IDecoration | undefined }[] = []
  #cursorHidden = false
  #lastKey = ""

  constructor(xterm: XTerm, engine: PredictionEngine, theme: () => ITheme) {
    this.#xterm = xterm
    this.#engine = engine
    this.#theme = theme
  }

  /** The real screen, as the engine reads it (viewport rows). */
  screen(): PredictionScreen {
    const buffer = this.#xterm.buffer.active
    return {
      cols: this.#xterm.cols,
      rows: this.#xterm.rows,
      cursorRow: buffer.cursorY,
      cursorCol: buffer.cursorX,
      alternate: buffer.type === "alternate",
      cellChars: (row, col) =>
        buffer
          .getLine(buffer.baseY + row)
          ?.getCell(col)
          ?.getChars() ?? "",
    }
  }

  /** Redraw from the engine's current view (after a key, an ack or new output). */
  draw(): void {
    const view = this.#engine.view(this.screen())
    const key = JSON.stringify(view)
    if (key === this.#lastKey) return
    this.#lastKey = key
    this.#clear()
    this.#render(view)
    this.#hideCursor(view.cursor !== null)
  }

  /** The theme xterm should use now (the app theme, with the cursor hidden while predicting). */
  theme(): ITheme {
    const base = this.#theme()
    return this.#cursorHidden
      ? { ...base, cursor: "transparent", cursorAccent: base.foreground }
      : base
  }

  dispose(): void {
    this.#clear()
    this.#hideCursor(false)
  }

  #clear(): void {
    for (const { marker, decoration } of this.#drawn) {
      decoration?.dispose()
      marker.dispose()
    }
    this.#drawn = []
  }

  #render(view: PredictionView): void {
    const xterm = this.#xterm
    const theme = this.#theme()
    const cursorY = xterm.buffer.active.cursorY
    const place = (row: number, col: number, paint: (element: HTMLElement) => void): void => {
      const marker = xterm.registerMarker(row - cursorY)
      const decoration = xterm.registerDecoration({ marker, x: col, width: 1, layer: "top" })
      decoration?.onRender((element) => {
        element.style.fontFamily = xterm.options.fontFamily ?? "monospace"
        element.style.fontSize = `${xterm.options.fontSize ?? 13}px`
        element.style.lineHeight = element.style.height
        element.style.whiteSpace = "pre"
        element.style.overflow = "hidden"
        paint(element)
      })
      this.#drawn.push({ marker, decoration })
    }
    for (const cell of view.cells) {
      place(cell.row, cell.col, (element) => {
        element.classList.add(PREDICTION_CLASS)
        element.textContent = cell.chars === "" ? " " : cell.chars
        element.style.background = theme.background ?? "#000000"
        element.style.color = theme.foreground ?? "#ffffff"
        element.style.textDecoration = cell.underline ? "underline" : "none"
      })
    }
    const cursor = view.cursor
    if (cursor !== null) {
      const predicted = view.cells.find(
        (cell) => cell.row === cursor.row && cell.col === cursor.col,
      )
      const under = predicted?.chars ?? this.screen().cellChars(cursor.row, cursor.col)
      place(cursor.row, cursor.col, (element) => {
        element.classList.add(PREDICTED_CURSOR_CLASS)
        element.textContent = under === "" ? " " : under
        element.style.background = theme.cursor ?? theme.foreground ?? "#ffffff"
        element.style.color = theme.cursorAccent ?? theme.background ?? "#000000"
      })
    }
  }

  #hideCursor(hidden: boolean): void {
    if (hidden === this.#cursorHidden) return
    this.#cursorHidden = hidden
    this.#xterm.options.theme = this.theme()
  }
}
