import type { TerminalAgent } from "./catalog"

export interface LaunchOptions {
  /** Extra arguments appended after the agent's default args. */
  args?: string[]
}

/**
 * Build the argv to run in the PTY for a terminal agent. node-pty spawns by
 * `(file, args)` with no shell, so nothing is interpolated into a command string
 * and no quoting is needed.
 *
 * Invariants (property-tested): `argv[0]` is always `agent.command`; the agent's
 * default args precede the caller's extra args, both preserved in order.
 */
export function buildLaunchArgv(agent: TerminalAgent, options: LaunchOptions = {}): string[] {
  return [agent.command, ...(agent.defaultArgs ?? []), ...(options.args ?? [])]
}

/**
 * Build the argv for a one-shot workflow run. The prompt is always one argv
 * element and callers spawn the returned command without a shell.
 */
export function buildNonInteractiveLaunchArgv(agent: TerminalAgent, prompt: string): string[] {
  if (agent.id === "claude-code") {
    return [agent.command, ...(agent.defaultArgs ?? []), "-p", prompt]
  }
  if (agent.id === "codex") {
    return [agent.command, ...(agent.defaultArgs ?? []), "exec", prompt]
  }
  throw new Error(`${agent.label} does not support non-interactive workflows`)
}
