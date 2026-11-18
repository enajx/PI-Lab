// The headless emulator beside each PTY, and safe screen snapshots.
//
// The daemon feeds the emulator only up to the last safe offset (parser in
// ground state, no half-read UTF-8 character) and holds the bytes after it. A
// snapshot is the serialized emulator at that offset plus the held bytes, so a
// client can attach at once even when the program stopped halfway through a
// sequence. The emulator is written synchronously, so its state always matches
// exactly the bytes before the safe offset.

import { SerializeAddon } from "@xterm/addon-serialize"
// @xterm/headless is CommonJS without named ESM exports; the daemon bundle is
// an ES module that imports it from node_modules, so take the default export.
import xtermHeadless, { type Terminal } from "@xterm/headless"
import { ParserTracker } from "./parserState"

const { Terminal: HeadlessTerminal } = xtermHeadless

/** Scrollback lines the emulator keeps and a snapshot includes. */
const EMULATOR_SCROLLBACK = 1000

/**
 * The start of a screen refresh, written into a client's xterm that already
 * holds the session's history: CAN ends any sequence the client stopped in,
 * `?47l` switches to the normal buffer, mouse reporting and its encoding go
 * off, DECSTR resets modes, text style, scroll region, charsets and the saved
 * cursor without touching history, and `CSI H CSI 2J` clears the visible rows
 * (xterm.js does not push them into history). The current screen follows.
 */
export const REFRESH_PREFIX = "\x18\x1b[?47l\x1b[?1000l\x1b[?1006l\x1b[!p\x1b[H\x1b[2J"

/**
 * xterm 5.5 internals that the public API and SerializeAddon 0.13 do not cover.
 * Checked when each emulator is created so an xterm update fails loudly.
 */
interface CoreInternals {
  writeSync(data: Uint8Array | string): void
  buffer: {
    x: number
    y: number
    ybase: number
    scrollTop: number
    scrollBottom: number
    savedX: number
    savedY: number
  }
  coreService: { isCursorHidden: boolean }
  coreMouseService: {
    activeEncoding: string
    triggerMouseEvent(event: {
      col: number
      row: number
      x: number
      y: number
      button: number
      action: number
      ctrl: boolean
      alt: boolean
      shift: boolean
    }): boolean
  }
  _charsetService: { glevel: number; _charsets: (Record<string, string> | undefined)[] }
}

const MOUSE_ENCODING_MODES: Record<string, string> = {
  DEFAULT: "",
  SGR: "\x1b[?1006h",
  SGR_PIXELS: "\x1b[?1016h",
  UTF8: "\x1b[?1005h",
  URXVT: "\x1b[?1015h",
}

/** The DEC special graphics charset maps `q` to a horizontal line. */
function isDecGraphics(charset: Record<string, string> | undefined): boolean {
  return charset?.q === "─"
}

function coreOf(terminal: Terminal): CoreInternals {
  const core = (terminal as unknown as { _core: CoreInternals })._core
  const buffer = core.buffer
  if (
    typeof core.writeSync !== "function" ||
    typeof buffer.scrollTop !== "number" ||
    typeof buffer.scrollBottom !== "number" ||
    typeof buffer.savedX !== "number" ||
    typeof buffer.savedY !== "number" ||
    typeof buffer.ybase !== "number" ||
    typeof core.coreService.isCursorHidden !== "boolean" ||
    typeof core.coreMouseService.activeEncoding !== "string" ||
    typeof core._charsetService.glevel !== "number" ||
    !Array.isArray(core._charsetService._charsets)
  ) {
    throw new Error("@xterm/headless internals changed; screen snapshots need an update")
  }
  return core
}

/** A headless xterm that is written synchronously and serializes its full state. */
export class Emulator {
  readonly terminal: Terminal
  private readonly addon = new SerializeAddon()
  private readonly core: CoreInternals

  constructor(cols: number, rows: number) {
    this.terminal = new HeadlessTerminal({
      cols,
      rows,
      scrollback: EMULATOR_SCROLLBACK,
      allowProposedApi: true,
      // writeSync warns once that it is unreliable with async parser handlers; there are none.
      logLevel: "error",
    })
    this.terminal.loadAddon(this.addon)
    this.core = coreOf(this.terminal)
  }

  write(data: Uint8Array | string): void {
    if (data.length > 0) this.core.writeSync(data)
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows)
  }

  scrollTop(): number {
    return this.core.buffer.scrollTop
  }

  mouseEncoding(): string {
    return this.core.coreMouseService.activeEncoding
  }

  /** Report a left-button press at a 0-based cell, as a click in a renderer would. */
  mouseClick(col: number, row: number): void {
    this.core.coreMouseService.triggerMouseEvent({
      col,
      row,
      x: 0,
      y: 0,
      button: 0,
      action: 1,
      ctrl: false,
      alt: false,
      shift: false,
    })
  }

  /**
   * Bytes that rebuild this screen in a reset terminal of the same size:
   * `all` includes the scrollback, `screen` only the visible rows (a refresh).
   *
   * SerializeAddon 0.13 writes the normal and alternate buffers, the current
   * text style and the modes in `terminal.modes`. It lacks the scroll region,
   * the saved cursor, the mouse encoding, cursor visibility and the G0/G1
   * charsets, and its origin mode output moves the cursor home after it placed
   * it. Those are added here, ending with an absolute cursor position.
   */
  serialize(rows: "all" | "screen"): string {
    const terminal = this.terminal
    const buffer = this.core.buffer
    let text = this.addon.serialize(rows === "screen" ? { scrollback: 0 } : undefined)
    const originMode = terminal.modes.originMode
    const region = buffer.scrollTop !== 0 || buffer.scrollBottom !== terminal.rows - 1
    // DECRC clamps the saved row to the screen, so a saved home position is the default.
    const savedRow = Math.max(buffer.savedY - buffer.ybase, 0)
    const saved = buffer.savedX !== 0 || savedRow !== 0
    const charsets = this.core._charsetService
    if (isDecGraphics(charsets._charsets[0])) text += "\x1b(0"
    if (isDecGraphics(charsets._charsets[1])) text += "\x1b)0"
    if (charsets.glevel === 1) text += "\x0e"
    text += MOUSE_ENCODING_MODES[this.core.coreMouseService.activeEncoding] ?? ""
    if (this.core.coreService.isCursorHidden) text += "\x1b[?25l"
    // With the cursor in the pending-wrap column the addon's own placement keeps
    // the pending wrap; a later absolute move would lose it.
    if (buffer.x >= terminal.cols && !originMode && !region && !saved) return text
    if (originMode) text += "\x1b[?6l"
    if (saved) {
      text += `\x1b[${savedRow + 1};${Math.min(buffer.savedX, terminal.cols - 1) + 1}H\x1b7`
    }
    if (region) text += `\x1b[${buffer.scrollTop + 1};${buffer.scrollBottom + 1}r`
    if (originMode) text += "\x1b[?6h"
    const row = buffer.y - (originMode ? buffer.scrollTop : 0)
    text += `\x1b[${row + 1};${Math.min(buffer.x, terminal.cols - 1) + 1}H`
    return text
  }

  dispose(): void {
    this.terminal.dispose()
  }
}

export interface ScreenSnapshot {
  /** Offset of the first byte the snapshot does not contain. */
  offset: number
  /** Serialized screen to write into a reset terminal of the current size. */
  screen: string
  /** Raw bytes from `offset` to the session's current offset. */
  bytes: Buffer
}

/** The emulator at the last safe offset plus the raw bytes held after it. */
export class ScreenState {
  private readonly emulator: Emulator
  private readonly tracker = new ParserTracker()
  private held = Buffer.alloc(0)
  private safeOffset = 0
  /** A line went into (or out of) the normal buffer's history during the current write. */
  private historyMoved = false
  /**
   * The normal buffer's history is the same for every offset from this one on
   * (chunk granularity): no line scrolled into it and it was not cleared since.
   */
  historyStableFrom = 0

  /**
   * @param heldLimit most bytes held after the safe offset (the retention limit)
   * @param onParserReset told how many held bytes were applied with a parser reset
   */
  constructor(
    cols: number,
    rows: number,
    private readonly heldLimit: number,
    private readonly onParserReset: (heldBytes: number) => void,
  ) {
    this.emulator = new Emulator(cols, rows)
    const terminal = this.emulator.terminal
    // A scroll with the region at the top of the normal buffer adds a history line.
    terminal.onScroll(() => {
      if (terminal.buffer.active.type === "normal" && this.emulator.scrollTop() === 0)
        this.historyMoved = true
    })
  }

  /** Feed the next output bytes, in order. */
  feed(chunk: Buffer): void {
    const lengthBefore = this.emulator.terminal.buffer.normal.length
    this.historyMoved = false
    this.write(chunk)
    // Clearing the scrollback (CSI 3 J, RIS) changes the length without a scroll.
    if (this.historyMoved || this.emulator.terminal.buffer.normal.length !== lengthBefore)
      this.historyStableFrom = this.safeOffset
  }

  private write(chunk: Buffer): void {
    const lastSafe = this.tracker.pushAndFindLastSafe(chunk)
    if (lastSafe >= 0) {
      this.emulator.write(this.held)
      this.emulator.write(chunk.subarray(0, lastSafe))
      this.safeOffset += this.held.length + lastSafe
      this.held = Buffer.from(chunk.subarray(lastSafe))
    } else {
      this.held = Buffer.concat([this.held, chunk])
    }
    if (this.held.length > this.heldLimit) {
      // CAN ends any sequence in xterm's parser, so the emulator matches the tracker.
      const heldBytes = this.held.length
      this.emulator.write(this.held)
      this.emulator.write("\x18")
      this.tracker.reset()
      this.safeOffset += heldBytes
      this.held = Buffer.alloc(0)
      this.onParserReset(heldBytes)
    }
  }

  resize(cols: number, rows: number): void {
    this.emulator.resize(cols, rows)
  }

  snapshot(): ScreenSnapshot {
    return { offset: this.safeOffset, screen: this.emulator.serialize("all"), bytes: this.held }
  }

  /**
   * The normal buffer's first visible row continues a history line. A refresh
   * cannot mark it as wrapped (only output that wraps does that), so it would
   * differ from this screen.
   */
  firstRowContinuesHistory(): boolean {
    const normal = this.emulator.terminal.buffer.normal
    return normal.baseY > 0 && normal.getLine(normal.baseY)?.isWrapped === true
  }

  /** The current screen for a client that holds the same history: see {@link REFRESH_PREFIX}. */
  refresh(): ScreenSnapshot {
    return {
      offset: this.safeOffset,
      screen: REFRESH_PREFIX + this.emulator.serialize("screen"),
      bytes: this.held,
    }
  }

  dispose(): void {
    this.emulator.dispose()
  }
}
