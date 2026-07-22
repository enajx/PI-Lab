/**
 * Registry of external CLI coding agents PI Lab can launch.
 *
 * An "agent" here is nothing more than a command run inside a PTY terminal (see
 * md/engineering/architecture.md (agent runtime)): PI Lab does not wrap these tools, parse their output, or read
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

/**
 * Agents shipped by default. Others (Gemini, Amp, opencode, …) are added here.
 *
 * `defaultArgs` carry the permission/approval-bypass flags each agent needs to run
 * unattended inside PI Lab: without them the CLIs block on a first-run "trust this
 * folder" / approval prompt (in a fresh worktree or on a headless summary run), so
 * a launched agent looks dead. PI Lab drives agents autonomously over the user's
 * own local repos, so these are applied to every launch. Codex's non-interactive
 * (`exec`) flags differ and are added in {@link buildNonInteractiveLaunchArgv}.
 */
export const BUILTIN_AGENTS: readonly TerminalAgent[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    command: "claude",
    detect: "claude",
    defaultArgs: ["--dangerously-skip-permissions"],
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    detect: "codex",
    defaultArgs: ["--dangerously-bypass-approvals-and-sandbox"],
  },
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
