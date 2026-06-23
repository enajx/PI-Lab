import type { SkipperDatabase } from "@skipper/local-db"
import type { DaemonClient } from "@skipper/pty-daemon"
import { BUILTIN_AGENTS, type TerminalAgent } from "@skipper/shared"
import { livePyToolsExec, type PyToolsExec } from "../diagnostics"
import { liveSshExec, type SshExec } from "../lib/ssh-config"
import type { LiveAgentRegistry } from "../sessions/liveAgentRegistry"

/**
 * Per-request context for the main-process appRouter.
 *
 * Everything a feature router needs is injected here rather than imported as a
 * module singleton, so the whole surface is `createCaller`-testable without a
 * window (AGENTS.md §14): tests pass a temp-file Drizzle handle, an in-process
 * daemon client, and a fake agent catalog.
 *
 *   - `db`              — the migrated local store (projects/workspaces/git rows).
 *   - `getDaemonClient` — a *getter* (not a ready value) so the PTY client can be
 *                         lazily adopt-or-spawned and transparently reconnected
 *                         by the supervisor; routers that never touch terminals
 *                         simply never call it.
 *   - `agentCatalog`    — the launchable external-CLI agents (AGENTS.md §8),
 *                         injectable so launch tests use a deterministic fake
 *                         binary instead of a real (paid) agent.
 *   - `liveAgents`      — per-project tally of live agent sessions, the input the
 *                         start-agent-session policy reads (AGENTS.md §8). Shared
 *                         across calls within one app instance; injectable so
 *                         each test gets its own.
 *   - `sshExec`         — reachability probe for the Cluster science tab
 *                         (AGENTS.md §1/§8). Injectable so the cluster router's
 *                         status tests use a deterministic fake instead of the
 *                         real `ssh` CLI / a live host.
 *   - `httpFetch`       — outbound HTTP for the Library science tab's Zotero /
 *                         Semantic Scholar calls (AGENTS.md §1). Injectable so
 *                         the library router's tests assert against mocked API
 *                         responses with zero network; the live path is the
 *                         platform `fetch`.
 *   - `pyToolsExec`     — one-shot exec for the editor's Python diagnostics
 *                         (`ty`/`pyrefly`/`ruff` via `uvx`; AGENTS.md §1, TODO
 *                         "Built-in editor"). Injectable so the diagnostics
 *                         router's tests feed canned tool output and a
 *                         "binary missing" branch with no `uv` installed.
 */
export interface AppContext {
  db: SkipperDatabase
  getDaemonClient: () => Promise<DaemonClient>
  agentCatalog: readonly TerminalAgent[]
  liveAgents: LiveAgentRegistry
  sshExec: SshExec
  httpFetch: HttpFetch
  pyToolsExec: PyToolsExec
}

/**
 * The slice of the platform `fetch` the Library router relies on. Narrowed to
 * the global `fetch` signature so a test fake is a plain function returning a
 * `Response` (or a minimal stand-in) — no `node-fetch`, no DOM lib coupling.
 */
export type HttpFetch = typeof fetch

/** Default agent catalog when the app doesn't override it (the built-ins). */
export const DEFAULT_AGENT_CATALOG: readonly TerminalAgent[] = BUILTIN_AGENTS

/** Default reachability probe — the real `ssh` CLI (AGENTS.md §8). */
export const DEFAULT_SSH_EXEC: SshExec = liveSshExec

/**
 * Default outbound HTTP — the platform `fetch`, bound so `this` stays correct.
 * The Library router calls Zotero / Semantic Scholar through this; tests inject
 * a fake instead.
 */
export const DEFAULT_HTTP_FETCH: HttpFetch = (...args) => fetch(...args)

/**
 * Default Python-tools exec — the live `uvx`-backed runner (AGENTS.md §1, TODO
 * "Built-in editor"). The diagnostics router calls `ty`/`pyrefly`/`ruff` through
 * this; tests inject a deterministic fake instead.
 */
export const DEFAULT_PY_TOOLS_EXEC: PyToolsExec = livePyToolsExec

/**
 * Deterministic, credential-free agent used only in test mode (AGENTS.md §14).
 * It runs the bundled Node/Electron binary to print a known marker and exit, so
 * the projects E2E can click "Open agent" and assert real PTY output without a
 * paid agent or network. Its id is what the project view selects in test mode.
 */
export const TEST_AGENT_ID = "test-echo"

export const TEST_AGENT: TerminalAgent = {
  id: TEST_AGENT_ID,
  label: "Test Echo",
  command: process.execPath,
  detect: "node",
  defaultArgs: ["-e", "process.stdout.write('AGENT-UI-OK\\n')"],
}

/**
 * Build the launchable agent catalog for an app instance. In test mode the
 * deterministic {@link TEST_AGENT} is appended so the E2E has an assertable agent
 * to launch; in normal use it's just the built-ins (AGENTS.md §8).
 */
export function buildAgentCatalog(testMode: boolean): readonly TerminalAgent[] {
  return testMode ? [...BUILTIN_AGENTS, TEST_AGENT] : BUILTIN_AGENTS
}
