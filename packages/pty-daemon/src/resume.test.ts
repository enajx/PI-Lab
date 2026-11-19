// Resume and snapshot done checks from md/plans/multi-machine-step1.md, run
// against a real in-process daemon, real PTYs and a real Unix socket. Each
// viewer is a client-side @xterm/headless terminal fed from a DaemonClient and
// checks that every byte it applies starts exactly at its consumed offset.

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { type AttachResult, DaemonClient } from "./client"
import type { DataEvent, ResizeEvent, ResumePoint } from "./protocol"
import { Emulator } from "./screen"
import { DaemonServer } from "./server"

const NODE = process.execPath
const PROGRAM = join(__dirname, "testPrograms", "screenProgram.cjs")
const COLS = 80
const ROWS = 24

let socketDir: string
let socketPath: string
let server: DaemonServer
const clients: DaemonClient[] = []
const viewers: Viewer[] = []

afterEach(async () => {
  for (const viewer of viewers) viewer.emulator.dispose()
  viewers.length = 0
  for (const client of clients) client.close()
  clients.length = 0
  await server.close()
  await rm(socketDir, { recursive: true, force: true })
})

async function startServer(scrollbackBytes: number): Promise<void> {
  socketDir = await mkdtemp(join(tmpdir(), "pi-lab-resume-"))
  socketPath = join(socketDir, "daemon.sock")
  server = new DaemonServer({ socketPath, store: { scrollbackBytes } })
  await server.listen()
}

async function newClient(): Promise<DaemonClient> {
  const client = new DaemonClient(socketPath)
  await client.connect()
  clients.push(client)
  return client
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("waitFor timed out")
}

/** The xterm 5.5 internals the state comparison reads. */
interface TestCore {
  buffer: {
    scrollTop: number
    scrollBottom: number
    savedX: number
    savedY: number
    ybase: number
  }
  coreService: { isCursorHidden: boolean }
  coreMouseService: { activeEncoding: string }
  _charsetService: { glevel: number; _charsets: (Record<string, string> | undefined)[] }
}

/** A client terminal: applies attach starts and live events in offset order. */
class Viewer {
  readonly emulator: Emulator
  client: DaemonClient | null = null
  generation = ""
  offset = 0
  revision = 0
  received = 0
  paused = false
  queued: (DataEvent | ResizeEvent)[] = []
  starts: AttachResult["start"]["mode"][] = []

  constructor(
    readonly sessionId: string,
    cols: number,
    rows: number,
  ) {
    this.emulator = new Emulator(cols, rows)
    viewers.push(this)
  }

  /** The resume point the last attach was made from. */
  resumePointBeforeStart: ResumePoint | null = null

  /** Connect a new client and attach, resuming from `resume` when given. */
  async attach(resume: ResumePoint | null): Promise<AttachResult> {
    this.resumePointBeforeStart = resume
    const client = await newClient()
    this.client = client
    const onEvent = (event: DataEvent | ResizeEvent) => {
      if (event.sessionId !== this.sessionId || this.client !== client) return
      if (event.kind === "data") this.received = event.offset + event.bytes.length
      if (this.paused) this.queued.push(event)
      else this.apply(event)
    }
    client.on("data", onEvent)
    client.on("resize", onEvent)
    return client.attach(this.sessionId, resume, (result) => this.start(result))
  }

  /** Drop the connection; queued events are lost with it. */
  drop(): void {
    this.client?.close()
    this.client = null
    this.queued = []
    this.paused = false
  }

  /**
   * While paused: apply the queued events up to the first one with an escape
   * sequence, then only part of it, stopping right after its `ESC [`.
   */
  applyUpToMidSequence(): void {
    for (;;) {
      const event = this.queued.shift()
      if (event === undefined) throw new Error("no queued chunk with an escape sequence")
      if (event.kind !== "data") {
        this.apply(event)
        continue
      }
      const at = event.bytes.indexOf("\x1b[")
      if (at < 0) {
        this.apply(event)
        continue
      }
      this.emulator.write(event.bytes.subarray(0, at + 2))
      this.offset += at + 2
      return
    }
  }

  resumePoint(): ResumePoint {
    return { generation: this.generation, offset: this.offset, revision: this.revision }
  }

  private start(result: AttachResult): void {
    this.generation = result.generation
    this.revision = result.revision
    this.starts.push(result.start.mode)
    if (result.start.mode === "replay") {
      expect(result.start.offset).toBe(this.offset)
    } else if (result.start.mode === "refresh") {
      // The renderer's rule: a refresh applies only on top of the screen it was made for.
      expect(result.start.base).toEqual(this.resumePointBeforeStart)
      if (
        this.emulator.terminal.cols !== result.cols ||
        this.emulator.terminal.rows !== result.rows
      )
        this.emulator.resize(result.cols, result.rows)
      this.emulator.write(Buffer.from(result.start.screen))
    } else {
      this.emulator.terminal.reset()
      this.emulator.resize(result.cols, result.rows)
      this.emulator.write(result.start.screen)
    }
    this.emulator.write(result.start.bytes)
    this.offset = result.start.offset + result.start.bytes.length
    this.received = this.offset
  }

  private apply(event: DataEvent | ResizeEvent): void {
    // A gap or a duplicate shows up as an event that does not start at our offset.
    expect(event.offset).toBe(this.offset)
    expect(event.generation).toBe(this.generation)
    if (event.kind === "data") {
      this.emulator.write(event.bytes)
      this.offset += event.bytes.length
    } else {
      this.emulator.resize(event.cols, event.rows)
      this.revision = event.revision
    }
  }

  /** Every line of the normal or alternate buffer, history included. */
  allLines(): string[] {
    const buffer = this.emulator.terminal.buffer.active
    const lines: string[] = []
    for (let row = 0; row < buffer.length; row++)
      lines.push(buffer.getLine(row)?.translateToString(true) ?? "")
    return lines
  }

  /** The normal buffer's lines, history included (what a refresh must keep). */
  normalLines(): string[] {
    const buffer = this.emulator.terminal.buffer.normal
    const lines: string[] = []
    for (let row = 0; row < buffer.length; row++)
      lines.push(buffer.getLine(row)?.translateToString(true) ?? "")
    return lines
  }

  screenText(): string {
    const buffer = this.emulator.terminal.buffer.active
    const lines: string[] = []
    for (let row = 0; row < this.emulator.terminal.rows; row++) {
      lines.push(buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "")
    }
    return lines.join("\n")
  }

  /**
   * Everything a later byte or input event depends on. The xterm internals are
   * read directly (test-only access), so a field the snapshot leaves out shows
   * up here even though `serialize` would leave it out on both sides.
   */
  state(): object {
    const terminal = this.emulator.terminal
    const buffer = terminal.buffer.active
    const core = (terminal as unknown as { _core: TestCore })._core
    return {
      size: [terminal.cols, terminal.rows],
      buffer: buffer.type,
      cursor: [buffer.cursorX, buffer.cursorY],
      modes: terminal.modes,
      scrollRegion: [core.buffer.scrollTop, core.buffer.scrollBottom],
      // Where DECRC would put the cursor: the row is clamped to the top of the screen.
      savedCursor: [core.buffer.savedX, Math.max(core.buffer.savedY - core.buffer.ybase, 0)],
      cursorHidden: core.coreService.isCursorHidden,
      mouseEncoding: core.coreMouseService.activeEncoding,
      // G0 and G1; an unset slot and an explicit US ASCII designation are the same.
      charsets: [0, 1].map((slot) => core._charsetService._charsets[slot]?.q ?? null),
      glevel: core._charsetService.glevel,
      text: this.screenText(),
      serialized: this.emulator.serialize("all"),
    }
  }
}

/** Spawn the test program and attach the uninterrupted reference viewer. */
async function spawnProgram(
  scenario: string,
): Promise<{ control: DaemonClient; id: string; reference: Viewer }> {
  return spawnProgramSized(scenario, COLS, ROWS)
}

async function spawnProgramSized(
  scenario: string,
  cols: number,
  rows: number,
): Promise<{ control: DaemonClient; id: string; reference: Viewer }> {
  const control = await newClient()
  const session = await control.spawn({
    command: NODE,
    args: [PROGRAM, scenario],
    cols,
    rows,
  })
  await control.detach(session.id)
  const reference = new Viewer(session.id, cols, rows)
  await reference.attach(null)
  await waitFor(() => reference.screenText().includes("R"), 15_000)
  return { control, id: session.id, reference }
}

/** Wait until every viewer shows FINAL at the same offset, then compare states. */
async function expectSameEnd(reference: Viewer, others: Viewer[]): Promise<void> {
  await waitFor(
    () =>
      reference.screenText().includes("FINAL") &&
      others.every((viewer) => viewer.offset === reference.offset),
    10_000,
  )
  for (const viewer of others) expect(viewer.state()).toEqual(reference.state())
}

describe("resume, two variants", () => {
  test.each([
    ["queued chunk kept: resume from the last received offset", false],
    ["queued chunk discarded: resume from an earlier consumed offset", true],
  ])(
    "%s",
    async (_label, discard) => {
      await startServer(256 * 1024)
      const { control, id, reference } = await spawnProgram("stream")
      const resumer = new Viewer(id, COLS, ROWS)
      await resumer.attach(null)
      await control.write(id, "g")
      await waitFor(() => resumer.offset > 2000, 5000)

      if (discard) {
        resumer.paused = true
        await waitFor(() => resumer.queued.some((event) => event.kind === "data"), 5000)
        expect(resumer.received).toBeGreaterThan(resumer.offset)
      }
      const point = resumer.resumePoint()
      resumer.drop()
      // Output continues while the connection is down.
      await waitFor(() => reference.offset > point.offset + 2000, 5000)

      const result = await resumer.attach(point)
      expect(result.start.mode).toBe("replay")
      expect(result.start.offset).toBe(point.offset)
      await control.write(id, "q")
      await expectSameEnd(reference, [resumer])
    },
    20_000,
  )
})

describe("expired tail", () => {
  test("a resize and reattach after the tail expired match the uninterrupted client", async () => {
    await startServer(4096)
    const { control, id, reference } = await spawnProgram("fullscreen")
    const returning = new Viewer(id, COLS, ROWS)
    await returning.attach(null)
    await control.write(id, "g")
    await waitFor(() => returning.offset > 1000, 5000)
    const point = returning.resumePoint()
    returning.drop()

    await waitFor(() => reference.offset > point.offset + 20_000, 5000)
    await control.resize(id, 100, 30)
    await waitFor(() => reference.emulator.terminal.cols === 100, 5000)
    await waitFor(() => reference.offset > point.offset + 30_000, 5000)

    // Reattach while output continues.
    const result = await returning.attach(point)
    expect(result.start.mode).toBe("snapshot")
    expect([result.cols, result.rows]).toEqual([100, 30])
    await waitFor(() => returning.offset > result.start.offset + 2000, 5000)
    await control.write(id, "q")
    await expectSameEnd(reference, [returning])
    expect(returning.emulator.terminal.buffer.active.type).toBe("alternate")
  }, 20_000)
})

describe("idle recovery", () => {
  test("a fresh client matches from the snapshot alone while the program is silent", async () => {
    await startServer(4096)
    const { control, id, reference } = await spawnProgram("burst")
    await control.write(id, "g")
    await waitFor(() => reference.screenText().includes("FINAL"), 5000)
    await waitFor(() => reference.offset > 20_000, 5000)

    // The tail no longer holds the start of the session.
    const probe = new Viewer(id, COLS, ROWS)
    const expired = await probe.attach({
      generation: reference.generation,
      offset: 0,
      revision: 0,
    })
    expect(expired.start.mode).not.toBe("replay")

    const fresh = new Viewer(id, COLS, ROWS)
    const result = await fresh.attach(null)
    expect(result.start.mode).toBe("snapshot")
    expect(fresh.offset).toBe(reference.offset)
    expect(fresh.state()).toEqual(reference.state())
  }, 20_000)
})

describe("stale revision", () => {
  test.each([
    // History lines scrolled before the client's offset, not after: its history is right.
    ["wider, no row wraps", 100, 30, "refresh"],
    // The first visible row continues a history line; a refresh cannot mark it wrapped.
    ["narrower, every row wraps", 40, ROWS, "snapshot"],
  ] as const)(
    "a client that returns after another client resized (%s) gets the current screen",
    async (_label, cols, rows, mode) => {
      await startServer(256 * 1024)
      const { control, id, reference } = await spawnProgram("static")
      await control.write(id, "g")
      await waitFor(() => reference.screenText().includes("FINAL"), 5000)

      const stale = new Viewer(id, COLS, ROWS)
      await stale.attach(null)
      const point = stale.resumePoint()
      stale.drop()

      await control.resize(id, cols, rows)
      await waitFor(() => reference.emulator.terminal.cols === cols, 5000)
      expect(stale.state()).not.toEqual(reference.state())

      const result = await stale.attach(point)
      expect(point.offset).toBe(reference.offset)
      expect(result.start.mode).toBe(mode)
      expect(stale.state()).toEqual(reference.state())
      expect(stale.normalLines()).toEqual(reference.normalLines())
    },
    20_000,
  )
})

describe("generation", () => {
  test("a resume point from another daemon generation gets a snapshot", async () => {
    await startServer(256 * 1024)
    const { control, id, reference } = await spawnProgram("static")
    await control.write(id, "g")
    await waitFor(() => reference.screenText().includes("FINAL"), 5000)
    const point = reference.resumePoint()
    const other = new Viewer(id, COLS, ROWS)
    other.offset = point.offset
    const result = await other.attach({ ...point, generation: "an-earlier-daemon" })
    expect(result.start.mode).toBe("snapshot")
    expect(result.generation).toBe(point.generation)
    expect(other.state()).toEqual(reference.state())
  }, 20_000)
})

/** Mirror of xterm's browser key and paste encoding, which headless lacks. */
function nextInput(viewer: Viewer): string[] {
  const terminal = viewer.emulator.terminal
  const sent: string[] = []
  const listener = terminal.onData((data) => sent.push(data))
  const modes = terminal.modes
  sent.push(modes.applicationCursorKeysMode ? "\x1bOA" : "\x1b[A")
  sent.push(modes.bracketedPasteMode ? "\x1b[200~paste\x1b[201~" : "paste")
  viewer.emulator.mouseClick(4, 6)
  listener.dispose()
  return sent
}

describe("input modes", () => {
  test("keys, mouse and paste after a snapshot restore match the attached client", async () => {
    await startServer(4096)
    const { control, id, reference } = await spawnProgram("burst")
    await control.write(id, "g")
    await waitFor(() => reference.screenText().includes("FINAL"), 5000)
    await waitFor(() => reference.offset > 20_000, 5000)

    const restored = new Viewer(id, COLS, ROWS)
    expect((await restored.attach(null)).start.mode).toBe("snapshot")
    expect(restored.emulator.mouseEncoding()).toBe("SGR")
    expect(restored.emulator.terminal.modes).toMatchObject({
      applicationCursorKeysMode: true,
      applicationKeypadMode: true,
      bracketedPasteMode: true,
      mouseTrackingMode: "drag",
      sendFocusMode: true,
    })
    expect(nextInput(restored)).toEqual(nextInput(reference))
    expect(nextInput(restored)[2]).toBe("\x1b[<0;5;7M")
    expect(restored.state()).toEqual(reference.state())
  }, 20_000)
})

describe("offsets with non-ASCII output", () => {
  test("offsets count raw bytes of emoji and CJK output", async () => {
    await startServer(256 * 1024)
    const { control, id, reference } = await spawnProgram("cjk")
    const start = reference.offset
    await control.write(id, "g")
    // Each line is 😀 (4 bytes), 中 (3 bytes) and CR LF after the PTY's ONLCR.
    await waitFor(() => reference.offset === start + 200 * 9, 5000)
    const fresh = new Viewer(id, COLS, ROWS)
    await fresh.attach(null)
    expect(fresh.offset).toBe(start + 200 * 9)
    expect(fresh.state()).toEqual(reference.state())
  }, 20_000)

  test("reconnect and tail expiry with non-ASCII output match the uninterrupted client", async () => {
    // A cap that is not a multiple of any character size cuts through characters.
    await startServer(4099)
    const { control, id, reference } = await spawnProgram("stream")
    const replayed = new Viewer(id, COLS, ROWS)
    const expired = new Viewer(id, COLS, ROWS)
    await replayed.attach(null)
    await expired.attach(null)
    await control.write(id, "g")
    await waitFor(() => replayed.offset > 500, 5000)
    const shortPoint = replayed.resumePoint()
    const longPoint = expired.resumePoint()
    replayed.drop()
    expired.drop()

    await waitFor(() => reference.offset > shortPoint.offset + 1000, 5000)
    expect((await replayed.attach(shortPoint)).start.mode).toBe("replay")
    await waitFor(() => reference.offset > longPoint.offset + 20_000, 5000)
    expect((await expired.attach(longPoint)).start.mode).toBe("snapshot")
    await control.write(id, "q")
    await expectSameEnd(reference, [replayed, expired])
  }, 20_000)
})

describe("paused mid-sequence", () => {
  test("a fresh client attaches at once and handles the rest of the sequence", async () => {
    await startServer(256 * 1024)
    const { control, id, reference } = await spawnProgram("partial")
    await control.write(id, "g")
    await waitFor(() => reference.screenText().includes("hello"), 5000)

    // Paused inside a CSI sequence.
    const midEscape = new Viewer(id, COLS, ROWS)
    const first = await midEscape.attach(null)
    expect(first.start.mode).toBe("snapshot")
    expect(first.start.bytes.toString()).toBe("\x1b[3")
    expect(midEscape.screenText()).toContain("hello")

    // Paused inside a UTF-8 character.
    const offsetBefore = reference.offset
    await control.write(id, "1")
    await waitFor(() => reference.offset > offsetBefore, 5000)
    const midCharacter = new Viewer(id, COLS, ROWS)
    const second = await midCharacter.attach(null)
    expect([...second.start.bytes]).toEqual([0xe4])
    expect(midCharacter.screenText()).toContain("hello red")

    await control.write(id, "2")
    await expectSameEnd(reference, [midEscape, midCharacter])
    expect(reference.screenText()).toContain("hello red 中 done FINAL")
    const red = reference.emulator.terminal.buffer.active.getLine(0)?.getCell(7)
    expect(red?.getChars()).toBe("r")
    expect(red?.getFgColor()).toBe(1)
  }, 20_000)

  test("a sequence longer than the retention limit falls back to a parser reset and logs it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await startServer(4096)
    const { control, id, reference } = await spawnProgram("osc")
    await control.write(id, "g")
    await waitFor(() => reference.offset > 20_000, 5000)

    const fresh = new Viewer(id, COLS, ROWS)
    const result = await fresh.attach(null)
    expect(result.start.mode).toBe("snapshot")
    expect(result.start.bytes.length).toBeLessThanOrEqual(4096)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("parser reset"))
    // The rest of the stream still arrives without a gap.
    await control.write(id, "1")
    await waitFor(() => fresh.screenText().includes("after FINAL"), 5000)
    await waitFor(() => reference.screenText().includes("after FINAL"), 5000)
    warn.mockRestore()
  }, 20_000)
})

describe("terminal flags", () => {
  test("the PTY keeps UTF-8 line editing (IUTF8) with raw-byte output", async () => {
    test.skipIf(process.platform === "win32")
    await startServer(256 * 1024)
    const client = await newClient()
    const chunks: Buffer[] = []
    const session = await client.spawn({
      command: "/bin/sh",
      args: ["-c", "sleep 0.5; stty -a; sleep 1"],
      cols: 120,
      rows: 24,
    })
    await client.attach(session.id, null)
    client.on("data", (event: DataEvent) => {
      if (event.sessionId === session.id) chunks.push(event.bytes)
    })
    await waitFor(() => Buffer.concat(chunks).toString("utf8").includes("iflags"), 5000)
    const flags = Buffer.concat(chunks).toString("utf8")
    expect(flags).toMatch(/(^|\s)iutf8(\s|$)/m)
  })
})

describe("screen refresh", () => {
  test("a full-screen app (scroll region, DEC graphics, origin mode, mouse SGR, bracketed paste, hidden cursor, alternate screen) resumed from inside an escape sequence gets a refresh; the next input and output match an attached client", async () => {
    await startServer(256 * 1024)
    const { control, id, reference } = await spawnProgram("tui")
    const resumer = new Viewer(id, COLS, ROWS)
    await resumer.attach(null)
    await control.write(id, "g")
    await waitFor(() => resumer.offset > 2000, 5000)
    resumer.paused = true
    await waitFor(() => resumer.queued.some((event) => event.kind === "data"), 5000)
    resumer.applyUpToMidSequence()
    const point = resumer.resumePoint()
    resumer.drop()
    // More output than a small replay while the client is away.
    await waitFor(() => reference.offset > point.offset + 40_000, 10_000)

    const result = await resumer.attach(point)
    expect(result.start.mode).toBe("refresh")
    if (result.start.mode !== "refresh") return
    expect(result.start.base).toEqual(point)
    expect(result.start.screen.length + result.start.bytes.length).toBeLessThan(16 * 1024)
    await control.write(id, "q")
    await expectSameEnd(reference, [resumer])
    expect(resumer.normalLines()).toEqual(reference.normalLines())
    expect(resumer.emulator.terminal.modes).toMatchObject({
      originMode: true,
      bracketedPasteMode: true,
      mouseTrackingMode: "drag",
    })
    expect(resumer.emulator.mouseEncoding()).toBe("SGR")
    expect(nextInput(resumer)).toEqual(nextInput(reference))
    // The same next output on both keeps them equal (G1 shifted out and in again).
    const before = reference.offset
    await control.write(id, "n")
    await waitFor(
      () =>
        reference.offset > before &&
        reference.screenText().includes("NEXT") &&
        resumer.offset === reference.offset,
      5000,
    )
    expect(resumer.state()).toEqual(reference.state())
  }, 30_000)

  test("lines scrolled into history after the client's offset: a small replay or a snapshot, never a refresh", async () => {
    await startServer(256 * 1024)
    const { control, id, reference } = await spawnProgram("stream")
    const short = new Viewer(id, COLS, ROWS)
    const long = new Viewer(id, COLS, ROWS)
    await short.attach(null)
    await long.attach(null)
    await control.write(id, "g")
    await waitFor(() => short.offset > 2000, 5000)
    const shortPoint = short.resumePoint()
    const longPoint = long.resumePoint()
    short.drop()
    long.drop()
    await waitFor(() => reference.offset > shortPoint.offset + 1000, 5000)
    expect((await short.attach(shortPoint)).start.mode).toBe("replay")
    await waitFor(() => reference.offset > longPoint.offset + 40_000, 10_000)
    expect((await long.attach(longPoint)).start.mode).toBe("snapshot")
    await control.write(id, "q")
    await expectSameEnd(reference, [short, long])
  }, 30_000)

  test("sizes: replay, refresh and snapshot bytes for a status line, a full-screen redraw and log lines, at 80x24 and 200x50", async () => {
    await startServer(256 * 1024)
    const rows: string[] = []
    for (const [cols, height] of [
      [80, 24],
      [200, 50],
    ] as const) {
      for (const scenario of ["status", "redraw", "stream"]) {
        const { control, id, reference } = await spawnProgramSized(scenario, cols, height)
        // Some history first (the stream scenario prints its log lines on "b").
        if (scenario !== "stream") await control.write(id, "g")
        await waitFor(() => reference.offset > (scenario === "stream" ? 0 : 300), 5000)
        await new Promise((resolve) => setTimeout(resolve, 100))
        const away = new Viewer(id, cols, height)
        await away.attach(null)
        const point = away.resumePoint()
        away.drop()
        await control.write(id, "b")
        await waitFor(() => reference.screenText().includes("FINAL"), 10_000)
        await new Promise((resolve) => setTimeout(resolve, 100))
        const result = await away.attach(point)
        const fresh = await (await newClient()).attach(id, null)
        const startBytes = (start: AttachResult["start"]): number =>
          (start.mode === "replay" ? 0 : start.screen.length) + start.bytes.length
        const replayBytes = reference.offset - point.offset
        rows.push(
          `${scenario} ${cols}x${height}: replay ${replayBytes} B, chosen ${result.start.mode} ${startBytes(result.start)} B, snapshot ${startBytes(fresh.start)} B`,
        )
        await expectSameEnd(reference, [away])
        if (scenario === "stream") expect(result.start.mode).toBe("snapshot")
        else expect(result.start.mode).toBe("refresh")
        expect(startBytes(result.start)).toBeLessThan(replayBytes)
        await control.kill(id)
      }
    }
    console.log(`[sizes]\n${rows.join("\n")}`)
  }, 120_000)
})
