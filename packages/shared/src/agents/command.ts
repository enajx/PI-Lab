import type { TerminalAgent } from "./catalog"

/** Provider CLI effort names; the selected model may support only a subset. */
export const AGENT_EFFORT_LEVELS: Readonly<Record<string, readonly string[]>> = {
  codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
  "claude-code": ["low", "medium", "high", "xhigh", "max", "ultracode"],
}

export interface LaunchOptions {
  /** Extra arguments appended after the agent's default args. */
  args?: string[]
  model?: string
  effort?: string
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
  const defaults = launchDefaultsArgv(agent, options)
  return [agent.command, ...(agent.defaultArgs ?? []), ...defaults, ...(options.args ?? [])]
}

/** The provider's model and effort flags, shared by interactive and one-shot launches. */
function launchDefaultsArgv(agent: TerminalAgent, options: LaunchOptions): string[] {
  const defaults: string[] = []
  if (agent.id === "codex" || agent.id === "claude-code") {
    if (options.model) defaults.push("--model", options.model)
    if (options.effort) {
      defaults.push(
        ...(agent.id === "codex"
          ? ["--config", `model_reasoning_effort=${JSON.stringify(options.effort)}`]
          : ["--effort", options.effort]),
      )
    }
  }
  return defaults
}

/**
 * Build the argv for a one-shot workflow run. The prompt is always one argv
 * element and callers spawn the returned command without a shell.
 */
export function buildNonInteractiveLaunchArgv(
  agent: TerminalAgent,
  prompt: string,
  options?: LaunchOptions,
): string[] {
  const defaults = launchDefaultsArgv(agent, options ?? {})
  if (agent.oneShotArgs) return [agent.command, ...agent.oneShotArgs, prompt]
  // Permission/approval-bypass flags belong in different positions per CLI:
  // Claude takes `--dangerously-skip-permissions` as a global flag; Codex needs
  // `--skip-git-repo-check --dangerously-bypass-approvals-and-sandbox` AFTER the
  // `exec` subcommand. The interactive `defaultArgs` (catalog) don't apply here.
  if (agent.id === "claude-code") {
    // `--dangerously-skip-permissions` rides `defaultArgs` (valid before `-p`).
    return [agent.command, ...(agent.defaultArgs ?? []), ...defaults, "-p", prompt]
  }
  if (agent.id === "codex") {
    return [
      agent.command,
      "exec",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      ...defaults,
      prompt,
    ]
  }
  throw new Error(`${agent.label} does not support non-interactive workflows`)
}
