// Unit tests for the Claude stream-json parser: a canned transcript of the exact
// event shapes Claude emits under `--output-format stream-json --verbose` is fed
// through the parser, asserting it (1) maps tool_use / init / text events to
// concise readable activity lines, (2) captures the final report from the
// `result` event (NOT the raw JSON, and NOT duplicated as an activity line), and
// (3) skips noise events (hooks, thinking, tool results, rate-limit).
import { describe, expect, test } from "vitest"
import { ClaudeStreamParser, eventToActivityLines, resultFromEvent } from "./claudeStreamParser"

/** One JSON object per line, exactly as Claude prints them (newline-terminated). */
function transcript(events: unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
}

const INIT = { type: "system", subtype: "init", model: "claude-sonnet-5", tools: [], cwd: "/repo" }
const READ = {
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/abs/train.py" } }] },
}
const EDIT = {
  type: "assistant",
  message: {
    content: [{ type: "tool_use", name: "Edit", input: { file_path: "/repo/RESEARCH.md" } }],
  },
}
const RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Photon drift is under control.",
  duration_ms: 1234,
}

describe("ClaudeStreamParser", () => {
  test("maps init + tool_use events to readable steps and captures the final report", () => {
    const parser = new ClaudeStreamParser()
    const lines = parser.ingest(transcript([INIT, READ, EDIT, RESULT]))

    // The activity log is the live steps — readable, not raw JSON.
    expect(lines).toEqual(["▶ claude-sonnet-5", "→ Read train.py", "→ Edit RESEARCH.md"])
    for (const line of lines) expect(line).not.toContain("{")

    // The report is the `.result` string — different from the activity lines, and
    // never pushed as one (fixes the "same text twice" duplication).
    expect(parser.result).toBe("Photon drift is under control.")
    expect(parser.isError).toBe(false)
    expect(lines).not.toContain("Photon drift is under control.")
  })

  test("skips noise: hooks, thinking, tool results, and rate-limit events", () => {
    const parser = new ClaudeStreamParser()
    const lines = parser.ingest(
      transcript([
        { type: "system", subtype: "hook_started", hook: "PreToolUse" },
        { type: "system", subtype: "hook_response" },
        { type: "system", subtype: "thinking_tokens", tokens: 42 },
        { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } },
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "x", content: "big file dump" }],
          },
        },
        { type: "rate_limit_event", tier: "default" },
      ]),
    )
    expect(lines).toEqual([])
    expect(parser.result).toBeNull()
  })

  test("shows only tool-use steps (not the model's prose), truncating long Bash commands", () => {
    const parser = new ClaudeStreamParser()
    const longCmd = `echo ${"x".repeat(200)}`
    const lines = parser.ingest(
      transcript([
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Reviewing recent commits." }] },
        },
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Bash", input: { command: longCmd } }] },
        },
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "TODO" } }] },
        },
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "WebSearch", input: {} }] },
        },
      ]),
    )
    // The text narration is the model's OUTPUT (it duplicates the report) — the
    // activity log shows only the commands/steps, never the prose.
    expect(lines).not.toContain("Reviewing recent commits.")
    expect(lines[0]?.startsWith("→ Bash: echo xxx")).toBe(true)
    expect(lines[0]?.endsWith("…")).toBe(true)
    expect(lines[0]?.length).toBeLessThan(longCmd.length)
    expect(lines[1]).toBe("→ Grep TODO")
    // Unknown tools fall back to just the name.
    expect(lines[2]).toBe("→ WebSearch")
  })

  test("handles JSON lines split across chunk boundaries and a trailing unterminated line", () => {
    const parser = new ClaudeStreamParser()
    const full = transcript([INIT])
    // Feed the init event one character at a time — no complete line until the \n.
    const collected: string[] = []
    for (const char of full) collected.push(...parser.ingest(char))
    expect(collected).toEqual(["▶ claude-sonnet-5"])

    // A result line printed WITHOUT a trailing newline is drained on flush.
    parser.ingest(JSON.stringify(RESULT))
    expect(parser.result).toBeNull() // still buffered — no newline yet.
    expect(parser.flush()).toEqual([]) // result events yield no activity line…
    expect(parser.result).toBe("Photon drift is under control.") // …but set the report.
  })

  test("ignores malformed / partial JSON lines without throwing", () => {
    const parser = new ClaudeStreamParser()
    const lines = parser.ingest(
      'not json at all\n{"type":"system","subtype":"init","model":"m"}\n{ broken\n',
    )
    expect(lines).toEqual(["▶ m"])
  })

  test("marks an is_error result as an error", () => {
    const parser = new ClaudeStreamParser()
    parser.ingest(transcript([{ type: "result", is_error: true, result: "model unavailable" }]))
    expect(parser.isError).toBe(true)
    expect(parser.result).toBe("model unavailable")
  })
})

describe("eventToActivityLines / resultFromEvent (pure mappers)", () => {
  test("resultFromEvent returns null for non-result events", () => {
    expect(resultFromEvent(INIT)).toBeNull()
    expect(resultFromEvent(RESULT)).toEqual({
      result: "Photon drift is under control.",
      isError: false,
    })
  })

  test("eventToActivityLines tolerates junk shapes", () => {
    expect(eventToActivityLines(null)).toEqual([])
    expect(eventToActivityLines("string")).toEqual([])
    expect(eventToActivityLines({ type: "assistant" })).toEqual([])
    expect(eventToActivityLines({ type: "assistant", message: { content: "nope" } })).toEqual([])
  })
})
