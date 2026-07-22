import { basename } from "node:path"

/**
 * Parser for Claude Code's `--output-format stream-json --verbose` output.
 *
 * In that mode `claude -p` prints **one JSON object per line** as it works (a
 * session-init line, one line per assistant turn, tool results, and a final
 * `result` line) instead of only printing its final message at the very end.
 * Feeding those lines through this parser turns the run into a *live* stream of
 * concise, human-readable activity lines — "what the agent is actually doing" —
 * while capturing the run's final report separately from the `result` line. So
 * the activity log (the live steps) and the report (the final `.result`) are two
 * different things, which is exactly what stops the old "same text shown twice"
 * behaviour.
 *
 * Verified event shapes (noise events are intentionally ignored):
 *   - `{"type":"system","subtype":"init","model":"…"}`            → `▶ <model>`
 *   - `{"type":"assistant","message":{"content":[…]}}`            → one line per
 *       `tool_use` (`→ Read train.py`, `→ Bash: <cmd>`) and per `text` narration.
 *   - `{"type":"result","result":"<final text>","is_error":…}`   → the report.
 *   - `system` hooks / `thinking` / `thinking_tokens` / `rate_limit_event` /
 *       `user` tool-results → skipped (they are chatter, not steps).
 */

/** Max characters kept from a Bash command / Grep pattern shown in the log. */
const MAX_INLINE = 80

/** Collapse whitespace to single spaces so a value renders as one clean line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/** Truncate an already one-lined value, marking elision with an ellipsis. */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Map one assistant `tool_use` content item to a single activity line. */
function toolUseLine(item: Record<string, unknown>): string {
  const name = typeof item.name === "string" ? item.name : "tool"
  const input =
    item.input && typeof item.input === "object" ? (item.input as Record<string, unknown>) : {}
  const filePath = typeof input.file_path === "string" ? input.file_path : null
  if (filePath) return `→ ${name} ${basename(filePath)}`
  if (name === "Bash" && typeof input.command === "string") {
    return `→ Bash: ${truncate(oneLine(input.command), MAX_INLINE)}`
  }
  if (name === "Grep" && typeof input.pattern === "string") {
    return `→ Grep ${truncate(oneLine(input.pattern), MAX_INLINE)}`
  }
  return `→ ${name}`
}

/**
 * Map one parsed stream-json event to zero or more activity lines. A `result`
 * event yields none here — the final report is extracted via {@link resultFromEvent}.
 */
export function eventToActivityLines(event: unknown): string[] {
  if (!event || typeof event !== "object") return []
  const e = event as Record<string, unknown>
  if (e.type === "system") {
    if (e.subtype === "init") {
      const model = typeof e.model === "string" ? e.model : "agent"
      return [`▶ ${model}`]
    }
    return [] // hook_started / hook_response / thinking_tokens / … — noise.
  }
  if (e.type === "assistant") {
    const message =
      e.message && typeof e.message === "object" ? (e.message as Record<string, unknown>) : null
    const content = message?.content
    if (!Array.isArray(content)) return []
    const lines: string[] = []
    for (const item of content) {
      if (!item || typeof item !== "object") continue
      const it = item as Record<string, unknown>
      if (it.type === "tool_use") lines.push(toolUseLine(it))
      // `text` is the model's prose OUTPUT — it duplicates the final report shown
      // below the log, so the activity log deliberately shows only the commands/
      // steps the agent RAN, not what it returned. `thinking` is private reasoning.
    }
    return lines
  }
  // user tool-results, rate_limit_event, unknown types → not a step.
  return []
}

/** The final report carried by a `result` event, or null if this isn't one. */
export interface ClaudeResult {
  result: string
  isError: boolean
}

/** Extract the run's final report + error flag from a `result` event, else null. */
export function resultFromEvent(event: unknown): ClaudeResult | null {
  if (!event || typeof event !== "object") return null
  const e = event as Record<string, unknown>
  if (e.type !== "result") return null
  return { result: typeof e.result === "string" ? e.result : "", isError: e.is_error === true }
}

/**
 * Stateful, incremental parser: feed it raw stdout chunks (which may split JSON
 * lines across chunk boundaries) via {@link ingest}; it returns the activity
 * lines produced by any newly-completed lines and accumulates the final report.
 * Call {@link flush} after the process exits to drain a trailing line that lacked
 * a newline. Malformed / partial JSON lines are skipped, never thrown.
 */
export class ClaudeStreamParser {
  private buffer = ""
  private finalResult: string | null = null
  private finalIsError = false

  ingest(chunk: string): string[] {
    this.buffer += chunk
    const out: string[] = []
    let newline = this.buffer.indexOf("\n")
    while (newline !== -1) {
      const raw = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      out.push(...this.handleLine(raw))
      newline = this.buffer.indexOf("\n")
    }
    return out
  }

  /** Process any buffered remainder (a final line without a trailing newline). */
  flush(): string[] {
    const raw = this.buffer
    this.buffer = ""
    return this.handleLine(raw)
  }

  private handleLine(raw: string): string[] {
    const line = raw.trim()
    if (!line) return []
    let event: unknown
    // A stream line may be partial or non-JSON; skip it rather than crashing the
    // run (the surrounding run still surfaces process failures/timeouts).
    try {
      event = JSON.parse(line)
    } catch {
      return []
    }
    const result = resultFromEvent(event)
    if (result) {
      this.finalResult = result.result
      this.finalIsError = result.isError
      return [] // the final report is NOT echoed as an activity line.
    }
    return eventToActivityLines(event)
  }

  /** The captured final report text, or null if no `result` line was seen. */
  get result(): string | null {
    return this.finalResult
  }

  /** Whether the final `result` line reported an error. */
  get isError(): boolean {
    return this.finalIsError
  }
}
