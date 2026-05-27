import { describe, expect, test } from "vitest"
import {
  type ClientRequest,
  type DaemonFrame,
  encodeFrame,
  FrameDecoder,
  parseClientRequest,
  parseDaemonFrame,
} from "./protocol"

describe("encodeFrame / FrameDecoder", () => {
  test("round-trips a single frame", () => {
    const frame: ClientRequest = { kind: "list", cid: "abc" }
    const decoder = new FrameDecoder()
    const decoded = decoder.push(encodeFrame(frame))
    expect(decoded).toEqual([frame])
  })

  test("each encoded frame ends in exactly one newline", () => {
    const line = encodeFrame({ kind: "list", cid: "x" })
    expect(line.endsWith("\n")).toBe(true)
    expect(line.indexOf("\n")).toBe(line.length - 1)
  })

  test("recovers frames split across chunk boundaries", () => {
    const a = encodeFrame({ kind: "list", cid: "1" })
    const b = encodeFrame({ kind: "list", cid: "2" })
    const joined = a + b
    const decoder = new FrameDecoder()
    // Feed one byte at a time to stress partial reads.
    const out: unknown[] = []
    for (const ch of joined) out.push(...decoder.push(ch))
    expect(out).toEqual([
      { kind: "list", cid: "1" },
      { kind: "list", cid: "2" },
    ])
  })

  test("handles multiple frames coalesced into one chunk", () => {
    const decoder = new FrameDecoder()
    const chunk =
      encodeFrame({ kind: "list", cid: "1" }) +
      encodeFrame({ kind: "kill", cid: "2", sessionId: "s" })
    expect(decoder.push(chunk)).toEqual([
      { kind: "list", cid: "1" },
      { kind: "kill", cid: "2", sessionId: "s" },
    ])
  })

  test("carries terminal bytes (newlines, control chars) without corrupting framing", () => {
    const event: DaemonFrame = { kind: "data", sessionId: "s", chunk: "line1\nline2\r\n[0m" }
    const decoder = new FrameDecoder()
    const [decoded] = decoder.push(encodeFrame(event))
    expect(parseDaemonFrame(decoded)).toEqual(event)
  })
})

describe("parseClientRequest", () => {
  test("accepts a well-formed spawn with optionals", () => {
    const value = {
      kind: "spawn",
      cid: "c1",
      command: "bash",
      args: ["-l"],
      cwd: "/tmp",
      env: { FOO: "bar" },
      cols: 100,
      rows: 40,
    }
    expect(parseClientRequest(value)).toEqual(value)
  })

  test("accepts a minimal spawn", () => {
    const value = { kind: "spawn", cid: "c1", command: "bash" }
    expect(parseClientRequest(value)).toMatchObject({ kind: "spawn", command: "bash" })
  })

  test.each([
    ["missing cid", { kind: "list" }],
    ["unknown kind", { kind: "frobnicate", cid: "c" }],
    ["spawn without command", { kind: "spawn", cid: "c" }],
    ["spawn with non-string args", { kind: "spawn", cid: "c", command: "x", args: [1] }],
    ["write without data", { kind: "write", cid: "c", sessionId: "s" }],
    ["resize without rows", { kind: "resize", cid: "c", sessionId: "s", cols: 80 }],
    ["non-object", "nope"],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expect(parseClientRequest(value)).toBeNull()
  })
})

describe("parseDaemonFrame", () => {
  test("accepts replies and events", () => {
    expect(parseDaemonFrame({ kind: "list-ok", cid: "c", sessions: [] })).not.toBeNull()
    expect(parseDaemonFrame({ kind: "data", sessionId: "s", chunk: "x" })).not.toBeNull()
    expect(
      parseDaemonFrame({ kind: "exit", sessionId: "s", exitCode: 0, signal: null }),
    ).not.toBeNull()
  })

  test("rejects malformed frames", () => {
    expect(parseDaemonFrame({ kind: "data", sessionId: "s" })).toBeNull()
    expect(parseDaemonFrame({ kind: "list-ok" })).toBeNull()
    expect(parseDaemonFrame({ kind: "???" })).toBeNull()
    expect(parseDaemonFrame(42)).toBeNull()
  })
})
