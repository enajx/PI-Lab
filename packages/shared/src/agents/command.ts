import type { TerminalAgent } from "./catalog"

/** Provider CLI effort names; the selected model may support only a subset. */
export const AGENT_EFFORT_LEVELS: Readonly<Record<string, readonly string[]>> = {
  codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
  "claude-code": ["low", "medium", "high", "xhigh", "max", "ultracode"],
  gemini: ["low", "medium", "high", "xhigh", "max"],
}

/** How a launched agent signs in: the CLI's own login, or the API key saved in PI Lab. */
export type AgentAuthMethod = "subscription" | "api-key"

export interface LaunchOptions {
  /** Extra arguments appended after the agent's default args. */
  args?: string[]
  model?: string
  effort?: string
  /** Folders outside the working directory the agent may also use (needs `addDirArg`). */
  extraDirs?: string[]
  /** "api-key" makes the agent use the saved key; the key itself goes in the environment. */
  authMethod?: AgentAuthMethod
  /** Folder the agent runs in; agy is told to trust it so it does not stop on a trust prompt. */
  workingDir?: string
}

/**
 * Build the argv to run in the PTY for a terminal agent. node-pty spawns by
 * `(file, args)` with no shell, so nothing is interpolated into a command string
 * and no quoting is needed.
 *
 * Invariants (property-tested): `argv[0]` is always `agent.command`; the agent's
 * default args precede the caller's extra args, both preserved in order. Extra
 * folders (`options.extraDirs`) are passed with the agent's `addDirArg`, then
 * `--`, then the caller's args; an agent without `addDirArg` gets none.
 */
export function buildLaunchArgv(agent: TerminalAgent, options: LaunchOptions = {}): string[] {
  const defaults = launchDefaultsArgv(agent, options)
  const addDirArg = agent.addDirArg
  const extraDirs = addDirArg ? (options.extraDirs ?? []).flatMap((dir) => [addDirArg, dir]) : []
  const callerArgs = options.args ?? []
  const args =
    agent.promptArg && callerArgs.length > 0 ? [agent.promptArg, ...callerArgs] : callerArgs
  // Claude's --add-dir takes several folders, so "--" ends the options before
  // the prompt; both Claude and Codex accept "--" there. A prompt behind its own
  // flag (`promptArg`) needs no separator.
  const separator = extraDirs.length > 0 && args.length > 0 && !agent.promptArg ? ["--"] : []
  return [
    agent.command,
    ...(agent.defaultArgs ?? []),
    ...defaults,
    ...extraDirs,
    ...separator,
    ...args,
  ]
}

/** The provider's model and effort flags, shared by interactive and one-shot launches. */
function launchDefaultsArgv(agent: TerminalAgent, options: LaunchOptions): string[] {
  const defaults: string[] = []
  if (agent.id === "codex" || agent.id === "claude-code" || agent.id === "gemini") {
    if (options.model) defaults.push("--model", options.model)
    if (options.effort) {
      defaults.push(
        ...(agent.id === "codex"
          ? ["--config", `model_reasoning_effort=${JSON.stringify(options.effort)}`]
          : ["--effort", options.effort]),
      )
    }
  }
  if (agent.id === "gemini") {
    // Session-only agy settings (`--settings`), so the user's settings.json is
    // never changed: trust the working folders (agy otherwise stops on a "trust
    // this folder" prompt that --dangerously-skip-permissions does not skip), and
    // with an API key use the "gemini" provider, the only one that reads GEMINI_API_KEY.
    const trusted = [
      ...(options.workingDir ? [options.workingDir] : []),
      ...(options.extraDirs ?? []),
    ]
    const settings = {
      ...(trusted.length > 0 ? { trustedWorkspaces: trusted } : {}),
      ...(options.authMethod === "api-key" ? { modelProvider: "gemini" } : {}),
    }
    if (Object.keys(settings).length > 0) defaults.push("--settings", JSON.stringify(settings))
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
