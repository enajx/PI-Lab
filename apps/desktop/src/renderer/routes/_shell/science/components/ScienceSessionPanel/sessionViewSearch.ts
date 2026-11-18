/**
 * The search values of a Tasks or Analysis address. Kept apart from the session panel
 * so the route files, which load at startup, do not pull in the panel, the editor and
 * the terminal.
 */

/** An agent session to open and focus, from the address (the Project Agents box, ⌥Tab, a notification). */
export interface FocusSessionRequest {
  sessionId: string
  agentId: string
  /** Tab label, e.g. "Claude Code". */
  agentLabel: string
}

/** A non-empty string search value, or undefined. */
function searchText(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

/** The search of a Tasks or Analysis address: a project to show and an agent session to focus. */
export interface SessionViewSearch {
  /** The project's machine when it lives on another machine (the view follows it); absent for this Mac. */
  machineId?: string
  projectId?: string
  /** Analysis: a project file to preview (project-relative). */
  file?: string
  sessionId?: string
  agentId?: string
  agentLabel?: string
}

/** Read a Tasks or Analysis address's search values, dropping empty and non-string ones. */
export function validateSessionViewSearch(search: Record<string, unknown>): SessionViewSearch {
  return {
    machineId: searchText(search.machineId),
    projectId: searchText(search.projectId),
    file: searchText(search.file),
    sessionId: searchText(search.sessionId),
    agentId: searchText(search.agentId),
    agentLabel: searchText(search.agentLabel),
  }
}

/** The agent session the address asks to focus, or null when it names none. */
export function focusSessionFromSearch(search: SessionViewSearch): FocusSessionRequest | null {
  const { sessionId, agentId, agentLabel } = search
  return sessionId && agentId ? { sessionId, agentId, agentLabel: agentLabel ?? agentId } : null
}
