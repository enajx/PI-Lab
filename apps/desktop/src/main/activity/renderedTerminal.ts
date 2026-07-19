import { Terminal } from "@xterm/headless"

export interface RenderedTerminal {
  write: (chunk: string, callback: () => void) => void
  resize: (cols: number, rows: number) => void
  screen: () => string
  cursorLine: () => string
  dispose: () => void
}

export type RenderedTerminalFactory = (cols: number, rows: number) => RenderedTerminal

/**
 * Headless xterm uses the same 5.5 parser/buffer semantics as the renderer's
 * xterm, so classification sees the TUI screen the user sees after ANSI cursor
 * movement and redraws rather than misleading raw chunks.
 */
export const createHeadlessRenderedTerminal: RenderedTerminalFactory = (cols, rows) => {
  const terminal = new Terminal({ cols, rows, scrollback: 1_000, allowProposedApi: true })
  return {
    write: (chunk, callback) => terminal.write(chunk, callback),
    resize: (nextCols, nextRows) => terminal.resize(nextCols, nextRows),
    screen: () => {
      const buffer = terminal.buffer.active
      const firstLine = buffer.viewportY
      const lastLine = Math.min(buffer.length, firstLine + terminal.rows)
      const lines: string[] = []
      for (let index = firstLine; index < lastLine; index += 1) {
        lines.push(buffer.getLine(index)?.translateToString(true) ?? "")
      }
      return lines.join("\n")
    },
    cursorLine: () => {
      const buffer = terminal.buffer.active
      return buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? ""
    },
    dispose: () => terminal.dispose(),
  }
}
