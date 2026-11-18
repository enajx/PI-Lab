import { describe, expect, test } from "vitest"
import { PredictionEngine, type PredictionScreen } from "./localEcho"

/**
 * A plain grid with a cursor standing in for the client's xterm. The tests
 * play the program's part by writing into it before the echo ack is applied,
 * as the daemon's bytes would. The engine's behaviour through the real app is
 * checked in the E2E typing tests.
 */
class Grid implements PredictionScreen {
  readonly lines: string[][]
  cursorRow = 0
  cursorCol = 0
  alternate = false

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.lines = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ""))
  }

  cellChars(row: number, col: number): string {
    return this.lines[row]?.[col] ?? ""
  }

  /** Print text at the cursor, as a program's echo. */
  print(text: string): void {
    for (const char of text) {
      ;(this.lines[this.cursorRow] as string[])[this.cursorCol] = char
      this.cursorCol += 1
    }
  }

  backspace(): void {
    this.cursorCol -= 1
    ;(this.lines[this.cursorRow] as string[])[this.cursorCol] = ""
  }

  newline(): void {
    this.cursorRow += 1
    this.cursorCol = 0
  }
}

function shown(engine: PredictionEngine, grid: Grid): string {
  return engine
    .view(grid)
    .cells.map((cell) => cell.chars)
    .join("")
}

/** An engine that already measured `ms` of round trip, at a "$ " prompt. */
function setup(ms: number): { engine: PredictionEngine; grid: Grid } {
  const engine = new PredictionEngine("adaptive")
  engine.roundTrip(ms)
  const grid = new Grid(40, 5)
  grid.print("$ ")
  return { engine, grid }
}

describe("local echo prediction (Mosh engine port)", () => {
  test("an epoch shows nothing until one of its predictions is confirmed; then later keys show at once", () => {
    const { engine, grid } = setup(100)
    engine.key("l", 1, grid)
    expect(shown(engine, grid)).toBe("")
    // The program echoes "l"; the ack for key 1 confirms the epoch.
    grid.print("l")
    engine.ack(1, grid)
    engine.key("s", 2, grid)
    expect(shown(engine, grid)).toBe("s")
    expect(engine.view(grid).cursor).toEqual({ row: 0, col: 4 })
    grid.print("s")
    engine.ack(2, grid)
    expect(engine.view(grid).cells).toEqual([])
    expect(engine.view(grid).cursor).toBeNull()
  })

  test("over 80 ms predictions are underlined; at 30 to 80 ms they are not; at or below 30 ms they are not shown", () => {
    for (const [ms, visible, underline] of [
      [100, true, true],
      [50, true, false],
      [10, false, false],
    ] as const) {
      const { engine, grid } = setup(ms)
      engine.key("a", 1, grid)
      grid.print("a")
      engine.ack(1, grid)
      engine.key("b", 2, grid)
      const cells = engine.view(grid).cells
      expect(cells.length > 0, `${ms} ms shown`).toBe(visible)
      if (visible) expect(cells[0]?.underline, `${ms} ms underline`).toBe(underline)
    }
  })

  test("always shows predictions at any round trip; off predicts nothing", () => {
    const { engine, grid } = setup(1)
    engine.setMode("always")
    engine.key("a", 1, grid)
    grid.print("a")
    engine.ack(1, grid)
    engine.key("b", 2, grid)
    expect(shown(engine, grid)).toBe("b")
    engine.setMode("off")
    engine.key("c", 3, grid)
    expect(shown(engine, grid)).toBe("")
  })

  test("hidden input: after Enter at a password prompt that echoes nothing, no typed character is ever shown", () => {
    const { engine, grid } = setup(100)
    engine.key("s", 1, grid)
    grid.print("s")
    engine.ack(1, grid)
    engine.key("\r", 2, grid)
    grid.newline()
    grid.print("Password: ")
    engine.ack(2, grid)
    const views: string[] = []
    for (const [index, char] of [..."hunter2"].entries()) {
      engine.key(char, 3 + index, grid)
      views.push(shown(engine, grid))
      // The program does not echo; the ack shows the cell is still empty.
      engine.ack(3 + index, grid)
      views.push(shown(engine, grid))
    }
    expect(views.join("")).toBe("")
  })

  test("while ECHO is off nothing is predicted, and pending predictions are removed", () => {
    const { engine, grid } = setup(100)
    engine.key("a", 1, grid)
    grid.print("a")
    engine.ack(1, grid)
    engine.key("b", 2, grid)
    expect(shown(engine, grid)).toBe("b")
    engine.setEcho(false)
    expect(shown(engine, grid)).toBe("")
    engine.key("c", 3, grid)
    expect(shown(engine, grid)).toBe("")
  })

  test("a rejected prediction (the program echoes uppercase) is removed at the ack", () => {
    const { engine, grid } = setup(100)
    engine.setMode("always")
    // Confirm an epoch first with a key the program echoes the same.
    engine.key("1", 1, grid)
    grid.print("1")
    engine.ack(1, grid)
    engine.key("a", 2, grid)
    expect(shown(engine, grid)).toBe("a")
    grid.print("A")
    engine.ack(2, grid)
    expect(engine.view(grid)).toEqual({ cells: [], cursor: null })
  })

  test("Backspace and the arrows move the predicted cursor; Backspace predicts the row moving left", () => {
    const { engine, grid } = setup(100)
    engine.key("a", 1, grid)
    grid.print("a")
    engine.ack(1, grid)
    engine.key("b", 2, grid)
    engine.key("\x7f", 3, grid)
    expect(engine.view(grid).cursor).toBeNull()
    engine.key("\x1b[D", 4, grid)
    expect(engine.view(grid).cursor).toEqual({ row: 0, col: 2 })
    engine.key("\x1b[C", 5, grid)
    expect(engine.view(grid).cursor).toBeNull()
  })

  test("Tab, up arrow, a wide character and paste start a new epoch: their keys show nothing until confirmed", () => {
    for (const breaker of ["\t", "\x1b[A", "中", "pasted text"]) {
      const { engine, grid } = setup(100)
      engine.key("a", 1, grid)
      grid.print("a")
      engine.ack(1, grid)
      engine.key(breaker, 2, grid)
      engine.key("b", 3, grid)
      expect(shown(engine, grid), JSON.stringify(breaker)).toBe("")
    }
  })

  test("never in the alternate screen (full-screen apps)", () => {
    const { engine, grid } = setup(100)
    engine.setMode("always")
    grid.alternate = true
    engine.key("a", 1, grid)
    grid.alternate = false
    expect(shown(engine, grid)).toBe("")
    engine.key("b", 2, grid)
    grid.alternate = true
    expect(engine.view(grid).cells).toEqual([])
  })

  test("reset clears every prediction (a start, resize, hide or skip)", () => {
    const { engine, grid } = setup(100)
    engine.key("a", 1, grid)
    grid.print("a")
    engine.ack(1, grid)
    engine.key("b", 2, grid)
    expect(shown(engine, grid)).toBe("b")
    engine.reset()
    expect(shown(engine, grid)).toBe("")
  })
})
