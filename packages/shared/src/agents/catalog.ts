/**
 * Registry of external CLI coding agents Skipper can launch.
 *
 * An "agent" here is nothing more than a command run inside a PTY terminal (see
 * docs/architecture.md (agent runtime)): Skipper does not wrap these tools, parse their output, or read
 * their credentials — they run as their own processes and authenticate
 * themselves. This registry is **pure data** so the UI can offer a choice of
 * agents and remember a default; supporting another tool is a new entry here,
 * not new code.
 */

export interface TerminalAgent {
  /** Stable identifier referenced by workspaces/automations (e.g. "claude-code"). */
  id: string
  /** User-facing label. */
  label: string
  /** Binary executed inside the PTY. */
  command: string
  /** Binary name to look for on PATH when checking availability. */
  detect: string
  /** Arguments always passed when launching this agent. */
  defaultArgs?: string[]
  /** Extra environment variables to set for the launched process. */
  env?: Record<string, string>
}

/** Agents shipped by default. Others (Gemini, Amp, opencode, …) are added here. */
export const BUILTIN_AGENTS: readonly TerminalAgent[] = [
  { id: "claude-code", label: "Claude Code", command: "claude", detect: "claude" },
  { id: "codex", label: "Codex", command: "codex", detect: "codex" },
] as const

/** Agent offered when the user hasn't chosen one. */
export const DEFAULT_AGENT_ID = "claude-code"

/** Look up a catalog entry by id (built-ins by default). */
export function getAgent(
  id: string,
  catalog: readonly TerminalAgent[] = BUILTIN_AGENTS,
): TerminalAgent | undefined {
  return catalog.find((agent) => agent.id === id)
}

/** All known agents (the built-ins by default). */
export function listAgents(
  catalog: readonly TerminalAgent[] = BUILTIN_AGENTS,
): readonly TerminalAgent[] {
  return catalog
}
