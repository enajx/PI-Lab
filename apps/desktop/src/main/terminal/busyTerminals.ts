import { basename, isAbsolute, relative, sep } from "node:path"
import type { SessionInfo } from "@pi-lab/pty-daemon"

/** A terminal whose work an explicit Quit would stop, as named in the Quit confirmation. */
export interface BusyTerminal {
  /** Project name, or the session's folder when it is outside every project. */
  project: string
  /** Name of the running program. */
  command: string
}

/** A project checkout (main or worktree) that terminals may run in. */
export interface ProjectRoot {
  project: string
  path: string
}

/** Shell names a PTY reports while the shell waits at its prompt. */
const SHELL_NAMES = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh"])

/**
 * Ordinary shells and Python runs that are doing work. A shell is idle while its
 * PTY's foreground process is a shell (macOS /bin/sh reports `bash`; a nested
 * shell also counts as idle). Any other live non-agent session, such as a Python
 * run, is busy while alive. A missing foreground name (daemon built before that
 * field) counts as busy so Quit never stops unknown work without asking.
 */
export function busyTerminals(
  sessions: readonly SessionInfo[],
  agentSessionIds: ReadonlySet<string>,
  roots: readonly ProjectRoot[],
): BusyTerminal[] {
  const busy: BusyTerminal[] = []
  for (const session of sessions) {
    if (!session.alive || agentSessionIds.has(session.id)) continue
    const foreground = session.foregroundProcess ? basename(session.foregroundProcess) : null
    const shell = SHELL_NAMES.has(basename(session.command))
    if (shell && foreground !== null && SHELL_NAMES.has(foreground)) continue
    busy.push({
      project: projectName(session.cwd, roots),
      command: foreground ?? basename(session.command),
    })
  }
  return busy
}

/** The longest project root containing `cwd` names it; otherwise the folder itself. */
function projectName(cwd: string, roots: readonly ProjectRoot[]): string {
  let best: ProjectRoot | null = null
  for (const root of roots) {
    const path = relative(root.path, cwd)
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) continue
    if (!best || root.path.length > best.path.length) best = root
  }
  return best?.project ?? cwd
}
