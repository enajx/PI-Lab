/**
 * Local echo prediction for direct typing: a TypeScript port of Mosh's
 * prediction engine (`PredictionEngine` in mosh `src/frontend/terminaloverlay.cc`,
 * GPL-3.0, Keith Winstein), cut down to what PI Lab agreed (2026-11-18,
 * md/branch-connection-layer.md, "Screen diffs and local echo"):
 *
 * - Predicted keys: printable single-width characters (insert at the cursor,
 *   shifting the rest of the row right), Backspace (DEL), left and right
 *   arrows. Enter predicts the cursor at the next row, column 0. Every other
 *   key (Tab, control keys, other escape sequences, up/down, wide characters,
 *   paste, IME text) and a character in the last column start a new epoch.
 * - Epochs: predictions of an epoch are not shown until one of them is
 *   confirmed. A wrong prediction in a tentative epoch removes that epoch; a
 *   wrong one in a confirmed epoch removes all predictions.
 * - Confirmation: each prediction expires at its key's sequence number. When
 *   the daemon's echo ack for that sequence number has been applied (the
 *   emulator consumed up to the ack's offset), the prediction is compared with
 *   the real cell: it is correct when the content matches and the cell did not
 *   hold that content before.
 * - Display: in `adaptive`, shown when the smoothed round trip is over 30 ms
 *   (off again at or below 20 ms, once nothing is shown), underlined over
 *   80 ms (off at or below 50 ms). `always` shows them at any round trip;
 *   `off` predicts nothing. Never in the alternate screen, never while the
 *   PTY's ECHO flag is off.
 *
 * Not taken from Mosh: the glitch trigger (showing predictions when one stays
 * pending for 250 ms even at a low round trip), copying the colours of nearby
 * cells, and the "experimental" display mode.
 *
 * The engine has no DOM code: it reads the real screen through
 * {@link PredictionScreen} and returns what to draw ({@link PredictionView});
 * the pane draws it as xterm decorations. Nothing is ever written into xterm.
 */

/** How local echo is shown (a setting). */
export type LocalEchoMode = "adaptive" | "always" | "off"

/** The real terminal screen as the engine reads it (viewport rows, 0-based). */
export interface PredictionScreen {
  cols: number
  rows: number
  cursorRow: number
  cursorCol: number
  /** The alternate buffer is active (a full-screen app). */
  alternate: boolean
  /** The characters in a visible cell; "" for an empty cell. */
  cellChars: (row: number, col: number) => string
}

/** One predicted cell to draw over the real one. */
export interface PredictedCell {
  row: number
  col: number
  /** "" draws an empty cell. */
  chars: string
  underline: boolean
}

/** What to draw now: predicted cells and, when it moved, the predicted cursor. */
export interface PredictionView {
  cells: PredictedCell[]
  cursor: { row: number; col: number } | null
}

const SRTT_TRIGGER_LOW_MS = 20
const SRTT_TRIGGER_HIGH_MS = 30
const FLAG_TRIGGER_LOW_MS = 50
const FLAG_TRIGGER_HIGH_MS = 80

/** Weight of a new round-trip sample in the smoothed value (as TCP's SRTT). */
const SRTT_GAIN = 1 / 8

type Validity = "pending" | "correct" | "correct-no-credit" | "incorrect" | "inactive"

const NEVER = Number.POSITIVE_INFINITY

function isBlank(chars: string): boolean {
  return chars === "" || chars === " "
}

/** One code point, printable and one column wide. */
function isSingleWidthPrintable(data: string): boolean {
  if (data.length !== 1) return false
  const code = data.charCodeAt(0)
  if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) return false
  // Combining marks (zero width) and East Asian wide or fullwidth ranges.
  if (/\p{M}/u.test(data)) return false
  return !/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\ud800-\udfff]/u.test(data)
}

class Overlay {
  expirationSeq = NEVER
  active = false
  tentativeUntilEpoch: number

  constructor(
    readonly col: number,
    tentativeUntilEpoch: number,
  ) {
    this.tentativeUntilEpoch = tentativeUntilEpoch
  }

  tentative(confirmedEpoch: number): boolean {
    return this.tentativeUntilEpoch > confirmedEpoch
  }

  reset(): void {
    this.expirationSeq = NEVER
    this.tentativeUntilEpoch = NEVER
    this.active = false
  }

  expire(seq: number): void {
    this.expirationSeq = seq
  }
}

class CursorMove extends Overlay {
  constructor(
    seq: number,
    public row: number,
    public colAt: number,
    tentativeUntilEpoch: number,
  ) {
    super(colAt, tentativeUntilEpoch)
    this.expirationSeq = seq
  }

  validity(screen: PredictionScreen, lateAck: number): Validity {
    if (!this.active) return "inactive"
    if (this.row >= screen.rows || this.colAt >= screen.cols) return "incorrect"
    if (lateAck >= this.expirationSeq) {
      return screen.cursorCol === this.colAt && screen.cursorRow === this.row
        ? "correct"
        : "incorrect"
    }
    return "pending"
  }
}

class CellOverlay extends Overlay {
  replacement = ""
  unknown = false
  /** No credit for a prediction that matches what the cell held before. */
  originalContents: string[] = []

  override reset(): void {
    this.unknown = false
    this.originalContents = []
    super.reset()
  }

  resetWithOriginal(): void {
    if (!this.active || this.unknown) {
      this.reset()
      return
    }
    this.originalContents.push(this.replacement)
    super.reset()
  }

  validity(screen: PredictionScreen, row: number, lateAck: number): Validity {
    if (!this.active) return "inactive"
    if (row >= screen.rows || this.col >= screen.cols) return "incorrect"
    if (lateAck < this.expirationSeq) return "pending"
    if (this.unknown) return "correct-no-credit"
    // Too easy to match by chance.
    if (isBlank(this.replacement)) return "correct-no-credit"
    const current = screen.cellChars(row, this.col)
    if (current === this.replacement) {
      return this.originalContents.includes(this.replacement) ? "correct-no-credit" : "correct"
    }
    return "incorrect"
  }
}

class RowOverlay {
  readonly cells: CellOverlay[]

  constructor(
    readonly row: number,
    cols: number,
    epoch: number,
  ) {
    this.cells = Array.from({ length: cols }, (_unused, col) => new CellOverlay(col, epoch))
  }
}

export class PredictionEngine {
  #mode: LocalEchoMode
  #rows: RowOverlay[] = []
  #cursors: CursorMove[] = []
  #predictionEpoch = 1
  #confirmedEpoch = 0
  #flagging = false
  #srttTrigger = false
  #srttMs: number | null = null
  /** The highest sequence number whose echo ack the emulator has applied. */
  #lateAck = -1
  /** The sequence number of the newest key. */
  #lastSeq = -1
  #lastSize: { cols: number; rows: number } | null = null
  #echoOff = false
  #disconnected = false

  constructor(mode: LocalEchoMode) {
    this.#mode = mode
  }

  get mode(): LocalEchoMode {
    return this.#mode
  }

  setMode(mode: LocalEchoMode): void {
    this.#mode = mode
    if (mode === "off") this.reset()
  }

  /** The smoothed round trip, or null before the first sample. */
  get roundTripMs(): number | null {
    return this.#srttMs
  }

  /** A round-trip sample: key sent to its echo ack, less the ack's own delay. */
  roundTrip(sampleMs: number): void {
    const sample = Math.max(0, sampleMs)
    this.#srttMs =
      this.#srttMs === null ? sample : this.#srttMs + (sample - this.#srttMs) * SRTT_GAIN
  }

  /** The PTY's ECHO flag. While it is off nothing is predicted. */
  setEcho(on: boolean): void {
    this.#echoOff = !on
    if (!on) this.reset()
  }

  /** While the connection is down, shown predictions are underlined (as in Mosh). */
  setDisconnected(disconnected: boolean): void {
    this.#disconnected = disconnected
  }

  /** Remove every prediction (a start, resize, hide or skip). */
  reset(): void {
    this.#cursors = []
    this.#rows = []
    this.#becomeTentative()
  }

  /** The echo ack for `seq` was applied: check the predictions up to it. */
  ack(seq: number, screen: PredictionScreen): void {
    if (seq > this.#lateAck) this.#lateAck = seq
    this.#cull(screen)
  }

  /** A key (or pasted text) the user sent with sequence number `seq`. */
  key(data: string, seq: number, screen: PredictionScreen): void {
    this.#lastSeq = seq
    if (this.#mode === "off") return
    if (this.#echoOff || screen.alternate) {
      this.reset()
      return
    }
    this.#cull(screen)
    if (data === "\x7f") this.#backspace(seq, screen)
    else if (data === "\x1b[C" || data === "\x1bOC") this.#moveCursor(1, seq, screen)
    else if (data === "\x1b[D" || data === "\x1bOD") this.#moveCursor(-1, seq, screen)
    else if (data === "\r") {
      this.#becomeTentative()
      this.#newlineCarriageReturn(seq, screen)
    } else if (isSingleWidthPrintable(data)) this.#insert(data, seq, screen)
    else this.#becomeTentative()
  }

  /** What to draw over the real screen now. */
  view(screen: PredictionScreen): PredictionView {
    const empty: PredictionView = { cells: [], cursor: null }
    if (this.#mode === "off" || this.#echoOff || screen.alternate) return empty
    if (!(this.#srttTrigger || this.#mode === "always")) return empty
    const flag = this.#flagging || this.#disconnected
    let cursor: { row: number; col: number } | null = null
    for (const move of this.#cursors) {
      if (!move.active || move.tentative(this.#confirmedEpoch)) continue
      if (move.row < screen.rows && move.colAt < screen.cols)
        cursor = { row: move.row, col: move.colAt }
    }
    if (cursor !== null && cursor.row === screen.cursorRow && cursor.col === screen.cursorCol)
      cursor = null
    const cells: PredictedCell[] = []
    for (const row of this.#rows) {
      if (row.row < 0 || row.row >= screen.rows) continue
      for (const cell of row.cells) {
        if (!cell.active || cell.col >= screen.cols || cell.tentative(this.#confirmedEpoch))
          continue
        if (cell.unknown) continue
        const actual = screen.cellChars(row.row, cell.col)
        if (actual === cell.replacement) continue
        cells.push({
          row: row.row,
          col: cell.col,
          chars: cell.replacement,
          underline: flag && !(isBlank(cell.replacement) && isBlank(actual)),
        })
      }
    }
    return { cells, cursor }
  }

  #becomeTentative(): void {
    this.#predictionEpoch += 1
  }

  #cursor(): CursorMove {
    const cursor = this.#cursors.at(-1)
    if (cursor === undefined) throw new Error("local echo: no cursor prediction")
    return cursor
  }

  #initCursor(seq: number, screen: PredictionScreen): void {
    const last = this.#cursors.at(-1)
    if (last === undefined) {
      const move = new CursorMove(seq, screen.cursorRow, screen.cursorCol, this.#predictionEpoch)
      move.active = true
      this.#cursors.push(move)
    } else if (last.tentativeUntilEpoch !== this.#predictionEpoch) {
      const move = new CursorMove(seq, last.row, last.colAt, this.#predictionEpoch)
      move.active = true
      this.#cursors.push(move)
    }
  }

  #rowAt(row: number, cols: number): RowOverlay {
    const found = this.#rows.find((entry) => entry.row === row)
    if (found !== undefined) return found
    const made = new RowOverlay(row, cols, this.#predictionEpoch)
    this.#rows.push(made)
    return made
  }

  /** Mark a cell as predicted in the current epoch, expiring at `seq`. */
  #claim(cell: CellOverlay, seq: number, actual: string): void {
    cell.resetWithOriginal()
    cell.active = true
    cell.tentativeUntilEpoch = this.#predictionEpoch
    cell.expire(seq)
    cell.originalContents.push(actual)
  }

  #insert(chars: string, seq: number, screen: PredictionScreen): void {
    this.#initCursor(seq, screen)
    const cursor = this.#cursor()
    const cols = screen.cols
    const row = this.#rowAt(cursor.row, cols)
    // A character in the last column is tricky: an editor may show a wrap mark, a shell wraps.
    if (cursor.colAt + 1 >= cols) this.#becomeTentative()
    // Insert: the rest of the row moves right by one.
    for (let col = cols - 1; col > cursor.colAt; col--) {
      const cell = row.cells[col] as CellOverlay
      this.#claim(cell, seq, screen.cellChars(cursor.row, col))
      const previous = row.cells[col - 1] as CellOverlay
      if (col === cols - 1) cell.unknown = true
      else if (previous.active) {
        cell.unknown = previous.unknown
        if (!previous.unknown) cell.replacement = previous.replacement
      } else {
        cell.unknown = false
        cell.replacement = screen.cellChars(cursor.row, col - 1)
      }
    }
    const cell = row.cells[cursor.colAt] as CellOverlay
    cell.resetWithOriginal()
    cell.active = true
    cell.tentativeUntilEpoch = this.#predictionEpoch
    cell.expire(seq)
    cell.replacement = chars
    cell.originalContents.push(screen.cellChars(cursor.row, cursor.colAt))
    cursor.expire(seq)
    if (cursor.colAt < cols - 1) cursor.colAt += 1
    else {
      this.#becomeTentative()
      this.#newlineCarriageReturn(seq, screen)
    }
  }

  #backspace(seq: number, screen: PredictionScreen): void {
    this.#initCursor(seq, screen)
    const cursor = this.#cursor()
    const cols = screen.cols
    const row = this.#rowAt(cursor.row, cols)
    if (cursor.colAt === 0) return
    cursor.colAt -= 1
    cursor.expire(seq)
    // Delete: the rest of the row moves left by one.
    for (let col = cursor.colAt; col < cols; col++) {
      const cell = row.cells[col] as CellOverlay
      this.#claim(cell, seq, screen.cellChars(cursor.row, col))
      if (col + 2 < cols) {
        const next = row.cells[col + 1] as CellOverlay
        if (next.active) {
          cell.unknown = next.unknown
          if (!next.unknown) cell.replacement = next.replacement
        } else {
          cell.unknown = false
          cell.replacement = screen.cellChars(cursor.row, col + 1)
        }
      } else {
        cell.unknown = true
      }
    }
  }

  #moveCursor(step: 1 | -1, seq: number, screen: PredictionScreen): void {
    this.#initCursor(seq, screen)
    const cursor = this.#cursor()
    if (step === 1 && cursor.colAt < screen.cols - 1) {
      cursor.colAt += 1
      cursor.expire(seq)
    } else if (step === -1 && cursor.colAt > 0) {
      cursor.colAt -= 1
      cursor.expire(seq)
    }
  }

  #newlineCarriageReturn(seq: number, screen: PredictionScreen): void {
    this.#initCursor(seq, screen)
    const cursor = this.#cursor()
    cursor.colAt = 0
    if (cursor.row === screen.rows - 1) {
      // No scroll prediction: the last row is predicted blank.
      const row = this.#rowAt(cursor.row, screen.cols)
      for (const cell of row.cells) {
        cell.active = true
        cell.tentativeUntilEpoch = this.#predictionEpoch
        cell.expire(seq)
        cell.replacement = ""
      }
    } else {
      cursor.row += 1
    }
  }

  #killEpoch(epoch: number, screen: PredictionScreen): void {
    this.#cursors = this.#cursors.filter((move) => !move.tentative(epoch - 1))
    const move = new CursorMove(
      this.#lastSeq + 1,
      screen.cursorRow,
      screen.cursorCol,
      this.#predictionEpoch,
    )
    move.active = true
    this.#cursors.push(move)
    for (const row of this.#rows)
      for (const cell of row.cells) if (cell.tentative(epoch - 1)) cell.reset()
    this.#becomeTentative()
  }

  #active(): boolean {
    if (this.#cursors.length > 0) return true
    return this.#rows.some((row) => row.cells.some((cell) => cell.active))
  }

  /** Check predictions against the real screen (Mosh's `cull`). */
  #cull(screen: PredictionScreen): void {
    if (this.#mode === "off") return
    if (this.#lastSize?.cols !== screen.cols || this.#lastSize.rows !== screen.rows) {
      this.#lastSize = { cols: screen.cols, rows: screen.rows }
      this.reset()
    }
    const srtt = this.#srttMs ?? 0
    if (srtt > SRTT_TRIGGER_HIGH_MS) this.#srttTrigger = true
    else if (this.#srttTrigger && srtt <= SRTT_TRIGGER_LOW_MS && !this.#active())
      this.#srttTrigger = false
    if (srtt > FLAG_TRIGGER_HIGH_MS) this.#flagging = true
    else if (srtt <= FLAG_TRIGGER_LOW_MS) this.#flagging = false

    this.#rows = this.#rows.filter((row) => row.row >= 0 && row.row < screen.rows)
    for (const row of this.#rows) {
      for (const cell of row.cells) {
        const validity = cell.validity(screen, row.row, this.#lateAck)
        if (validity === "incorrect") {
          if (cell.tentative(this.#confirmedEpoch)) {
            this.#killEpoch(cell.tentativeUntilEpoch, screen)
          } else {
            this.reset()
            return
          }
        } else if (validity === "correct" || validity === "correct-no-credit") {
          if (validity === "correct" && cell.tentativeUntilEpoch > this.#confirmedEpoch)
            this.#confirmedEpoch = cell.tentativeUntilEpoch
          cell.reset()
        }
      }
    }

    const last = this.#cursors.at(-1)
    if (last !== undefined && last.validity(screen, this.#lateAck) === "incorrect") {
      this.reset()
      return
    }
    this.#cursors = this.#cursors.filter(
      (move) => move.validity(screen, this.#lateAck) === "pending",
    )
  }
}
