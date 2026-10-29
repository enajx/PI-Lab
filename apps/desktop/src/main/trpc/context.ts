import type { PiLabDatabase } from "@pi-lab/local-db"
import type { DaemonClient } from "@pi-lab/pty-daemon"
import { BUILTIN_AGENTS, type TerminalAgent } from "@pi-lab/shared"
import type { ActivityMonitorPort } from "../activity"
import type { ActivityStatusFeed } from "../activity/statusFeed"
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
import type { PiLabChannel } from "../identity/channel"
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
 * Dependencies for the main-process router are injected so callers can run
 * against temporary stores and fake external services in tests.
 * `getDaemonClient` stays lazy because many requests never need a terminal.
 */
export interface AppContext {
  db: PiLabDatabase
  /** Packaged channel; source runs use Alpha. */
  appChannel?: PiLabChannel
  /** User home whose conventional global agent-skill roots are indexed read-only. */
  skillsHomeDir: string
  /** Read-only skills shipped with PI Lab; absent in isolated callers. */
  bundledSkillsDir?: string
  /** Read-only directory containing platform-specific bundled LaTeX tools. */
  latexResourcesDir?: string
  /** Writable channel-specific LaTeX support cache. */
  latexDataDir?: string
  /** User home for discovering a shared TinyTeX installation. */
  latexUserHome?: string
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
  /** Electron shell.trashItem: move a file or folder to the OS Trash. */
  trashPath: (path: string) => Promise<void>
  /** Electron clipboard.writeText, injected so router tests never touch the real clipboard. */
  writeClipboard: (text: string) => void
  pyToolsExec: PyToolsExec
  discoverPythonEnvironments: PythonEnvironmentDiscoverer
  resolvePythonRuntime: PythonRuntimeResolver
  analysisInteractive: AnalysisInteractivePort
  notifications: NotificationBrokers
  activityStatus: Pick<ActivityStatusFeed, "subscribe" | "projectsChanged">
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
  env: { ELECTRON_RUN_AS_NODE: "1" },
  defaultArgs: ["-e", "process.stdout.write('AGENT-UI-OK\\n')"],
}

/** A test-only agent that keeps producing output, for live-activity UI E2E coverage. */
export const TEST_ACTIVITY_AGENT_ID = "test-activity"

export const TEST_ACTIVITY_AGENT: TerminalAgent = {
  id: TEST_ACTIVITY_AGENT_ID,
  label: "Test Activity",
  command: process.execPath,
  detect: "node",
  env: { ELECTRON_RUN_AS_NODE: "1" },
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
