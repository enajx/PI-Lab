import type { PiLabDatabase } from "@pi-lab/local-db"
import type { DaemonClient } from "@pi-lab/pty-daemon"
import { BUILTIN_AGENTS, type TerminalAgent } from "@pi-lab/shared"
import type { ActivityMonitorPort } from "../activity"
import {
  type AgentExecutableResolver,
  type AgentLaunchEnvironmentResolver,
  liveAgentExecutableResolver,
  liveAgentLaunchEnvironment,
} from "../agents/executable"
import {
  type NonInteractiveProcessRunner,
  runNonInteractiveProcess,
} from "../automations/nonInteractiveRunner"
import type { CaffeineControllerPort } from "../caffeine"
import { livePyToolsExec, type PyToolsExec } from "../diagnostics"
import { liveSshExec, type SshExec } from "../lib/ssh-config"
import type { NotificationBrokers, NotificationService } from "../notifications"
import {
  livePythonEnvironmentDiscoverer,
  livePythonRuntimeResolver,
  type PythonEnvironmentDiscoverer,
  type PythonRuntimeResolver,
} from "../python"
import type { CredentialCipher } from "../setup/credentials"
import { liveSetupProbe, type SetupProbe } from "../setup/probe"
import type { ThumbnailImageProcessor } from "./projects/thumbnailImage"
import type { AnalysisInteractivePort } from "./science/analysis/interactive"

/**
 * Per-request context for the main-process appRouter.
 *
 * Everything a feature router needs is injected here rather than imported as a
 * module singleton, so the whole surface is `createCaller`-testable without a
 * window: tests pass a temp-file Drizzle handle, an in-process
 * daemon client, and a fake agent catalog.
 *
 *   - `db`              — the migrated local store (projects/workspaces/git rows).
 *   - `getDaemonClient` — a *getter* (not a ready value) so the PTY client can be
 *                         lazily adopt-or-spawned and transparently reconnected
 *                         by the supervisor; routers that never touch terminals
 *                         simply never call it.
 *   - `agentCatalog`    — the launchable external-CLI agents,
 *                         injectable so launch tests use a deterministic fake
 *                         binary instead of a real (paid) agent.
 *   - `activityMonitor` — durable, renderer-independent agent activity and the
 *                         live count used by the worktree policy.
 *   - `sshExec`         — reachability probe for the Cluster science tab.
 *                         Injectable so the cluster router's
 *                         status tests use a deterministic fake instead of the
 *                         real `ssh` CLI / a live host.
 *   - `httpFetch`       — outbound HTTP for the Library science tab's Zotero calls.
 *                         Injectable so the library router's tests
 *                         assert against mocked API responses with zero network; the
 *                         live path is the platform `fetch`.
 *   - `openPath`        — open a file with the OS default app, for the Library tab's
 *                         folder source (`science.library.openItem`). Injectable so the
 *                         library router's tests record the path with zero side effects;
 *                         the live path is Electron's `shell.openPath`.
 *   - `pyToolsExec`     — one-shot exec for the editor's Python diagnostics
 *                         (`ty`/`pyrefly`/`ruff` via `uvx`). Injectable so the diagnostics
 *                         router's tests feed canned tool output and a
 *                         "binary missing" branch with no `uv` installed.
 *   - `discoverPythonEnvironments` — chooser-only, shallow global-manager
 *                         discovery. Injectable so router tests never inspect
 *                         the developer's real home directory.
 */
export interface AppContext {
  db: PiLabDatabase
  /** User home whose conventional global agent-skill roots are indexed read-only. */
  skillsHomeDir: string
  getDaemonClient: () => Promise<DaemonClient>
  agentCatalog: readonly TerminalAgent[]
  resolveAgentExecutable: AgentExecutableResolver
  getAgentLaunchEnvironment: AgentLaunchEnvironmentResolver
  runNonInteractiveProcess: NonInteractiveProcessRunner
  setupProbe?: SetupProbe
  /** Encrypts API credentials before they enter local SQLite. Never renderer-visible. */
  credentialCipher: CredentialCipher
  sshExec: SshExec
  httpFetch: HttpFetch
  openPath: OpenPath
  /** Electron shell.showItemInFolder, injected for deterministic router tests. */
  revealPath: (path: string) => void | Promise<void>
  pyToolsExec: PyToolsExec
  discoverPythonEnvironments: PythonEnvironmentDiscoverer
  resolvePythonRuntime: PythonRuntimeResolver
  analysisInteractive: AnalysisInteractivePort
  notifications: NotificationBrokers
  activityMonitor: ActivityMonitorPort
  notificationService: NotificationService
  caffeine: CaffeineControllerPort
  thumbnailImageProcessor: ThumbnailImageProcessor
}

/**
 * The slice of the platform `fetch` the Library router relies on. Narrowed to
 * the global `fetch` signature so a test fake is a plain function returning a
 * `Response` (or a minimal stand-in) — no `node-fetch`, no DOM lib coupling.
 */
export type HttpFetch = typeof fetch

/**
 * Open a file with the OS default application. Mirrors Electron's `shell.openPath`
 * contract: resolves to an empty string on success, or a non-empty error message on
 * failure. Kept electron-free here (the type only) so the context stays importable in
 * tests; the live binding lives in the main entry where Electron is in scope.
 */
export type OpenPath = (path: string) => Promise<string>

/** Default agent catalog when the app doesn't override it (the built-ins). */
export const DEFAULT_AGENT_CATALOG: readonly TerminalAgent[] = BUILTIN_AGENTS
export const DEFAULT_AGENT_EXECUTABLE_RESOLVER = liveAgentExecutableResolver
export const DEFAULT_AGENT_LAUNCH_ENVIRONMENT = liveAgentLaunchEnvironment
export const DEFAULT_WORKFLOW_PROCESS_RUNNER: NonInteractiveProcessRunner = runNonInteractiveProcess
export const DEFAULT_SETUP_PROBE: SetupProbe = liveSetupProbe

/** Default reachability probe — the real `ssh` CLI. */
export const DEFAULT_SSH_EXEC: SshExec = liveSshExec

/**
 * Default outbound HTTP — the platform `fetch`, bound so `this` stays correct.
 * The Library router calls Zotero through this; tests inject a fake instead.
 */
export const DEFAULT_HTTP_FETCH: HttpFetch = (...args) => fetch(...args)

/**
 * Default Python-tools exec — the live `uvx`-backed runner. The diagnostics router calls `ty`/`pyrefly`/`ruff` through
 * this; tests inject a deterministic fake instead.
 */
export const DEFAULT_PY_TOOLS_EXEC: PyToolsExec = livePyToolsExec
export const DEFAULT_PYTHON_ENVIRONMENT_DISCOVERER: PythonEnvironmentDiscoverer =
  livePythonEnvironmentDiscoverer
export const DEFAULT_PYTHON_RUNTIME_RESOLVER: PythonRuntimeResolver = livePythonRuntimeResolver

/**
 * Deterministic, credential-free agent used only in test mode.
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

/** A test-only agent that keeps producing output, for live-activity UI E2E coverage. */
export const TEST_ACTIVITY_AGENT_ID = "test-activity"

export const TEST_ACTIVITY_AGENT: TerminalAgent = {
  id: TEST_ACTIVITY_AGENT_ID,
  label: "Test Activity",
  command: process.execPath,
  detect: "node",
  defaultArgs: ["-e", "setInterval(()=>process.stdout.write('AGENT-ACTIVE\\n'),100)"],
}

/** A test-only planning CLI that writes a proposal through the real PTY boundary. */
export const TEST_PLAN_AGENT: TerminalAgent = {
  id: "test-plan",
  label: "Test Plan",
  command: process.execPath,
  detect: "node",
  env: { ELECTRON_RUN_AS_NODE: "1" },
  defaultArgs: [
    "-e",
    "require('fs').writeFileSync('PROPOSED_RESEARCH.md', '# Planned project\\n')",
  ],
  oneShotArgs: [
    "-e",
    "require('fs').writeFileSync('PROPOSED_RESEARCH.md', '# Planned project\\n')",
  ],
}

/**
 * Build the launchable agent catalog for an app instance. In test mode the
 * deterministic {@link TEST_AGENT} is appended so the E2E has an assertable agent
 * to launch; in normal use it's just the built-ins.
 */
export function buildAgentCatalog(testMode: boolean): readonly TerminalAgent[] {
  return testMode
    ? [...BUILTIN_AGENTS, TEST_AGENT, TEST_ACTIVITY_AGENT, TEST_PLAN_AGENT]
    : BUILTIN_AGENTS
}
