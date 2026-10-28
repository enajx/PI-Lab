// Shared test plumbing for the projects/workspaces router suites (AGENTS.md
// a `createCaller` over a temp-file SQLite handle with the *real* generated
// migrations, a throwaway git repo, an in-process pty-daemon, and an injectable
// fake agent catalog. Everything is created with real tools (git init, real
// DaemonServer) — only the transport (caller vs IPC) and the daemon's home
// (in-process vs detached child) are substituted.

import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { getSettingsOrDefaults, type PiLabDatabase, runMigrations } from "@pi-lab/local-db"
import { DaemonClient, DaemonServer } from "@pi-lab/pty-daemon"
import type { TerminalAgent } from "@pi-lab/shared"
import type Database from "better-sqlite3"
import {
  type ActivityMonitorPort,
  ActivityRegistry,
  createActivityMonitor,
  systemActivityClock,
  systemActivityScheduler,
} from "../activity"
import { ActivityStatusFeed } from "../activity/statusFeed"
import type { AgentExecutableResolver, AgentLaunchEnvironmentResolver } from "../agents/executable"
import {
  type NonInteractiveProcessRunner,
  runNonInteractiveProcess,
} from "../automations/nonInteractiveRunner"
import type { CaffeineControllerPort, CaffeineSettings, CaffeineStatus } from "../caffeine"
import type { PyToolsExec } from "../diagnostics"
import type { PiLabChannel } from "../identity/channel"
import type { SshExec } from "../lib/ssh-config"
import {
  createNotificationBrokers,
  type NativeNotificationHandlers,
  type NativeNotificationInput,
  type NotificationBrokers,
  NotificationService,
} from "../notifications"
import type { PythonEnvironmentDiscoverer, PythonRuntimeResolver } from "../python"
import { testCredentialCipher } from "../setup/credentials"
import type { SetupProbe } from "../setup/probe"
import { appRouter } from "./appRouter"
import type { AppContext, HttpFetch, OpenPath } from "./context"
import type {
  AnalysisInteractivePort,
  AnalysisInteractiveResult,
  OpenReportInput,
  StartMarimoInput,
} from "./science/analysis/interactive"
import { createCallerFactory } from "./trpc"

const execFileAsync = promisify(execFile)
const createCaller = createCallerFactory(appRouter)

export type Caller = ReturnType<typeof createCaller>

/**
 * A deterministic, credential-free fake agent: it runs the test
 * runner's own Node and prints a known marker, so launchAgent exercises the real
 * PTY/launch/stream path with zero network and zero paid credentials.
 */
export const FAKE_AGENT: TerminalAgent = {
  id: "fake-agent",
  label: "Fake Agent",
  command: process.execPath,
  detect: "node",
  defaultArgs: ["-e", "process.stdout.write('AGENT-OK')"],
}

/**
 * A *long-lived* fake agent: it prints its marker then stays alive on an
 * interval until killed, so a test can keep a session "live" while it starts a
 * second concurrent agent (exercising the concurrency-spills-to-worktree
 * branch of the policy. Killing the PTY (or closing the daemon) ends it.
 */
export const LONG_FAKE_AGENT: TerminalAgent = {
  id: "long-fake-agent",
  label: "Long Fake Agent",
  command: process.execPath,
  detect: "node",
  defaultArgs: ["-e", "process.stdout.write('AGENT-LIVE');setInterval(()=>{},1000)"],
}

export interface Harness {
  caller: Caller
  db: PiLabDatabase
  /** Data dir backing the DB and managed worktrees (honored by the routers). */
  dataDir: string
  /** Deterministic stand-in for the user's home during global Skills discovery. */
  skillsHomeDir: string
  /** A throwaway folder, initialized as Git unless setup explicitly disables it. */
  repoDir: string
  /** In lazy mode, request a terminal router procedure before direct client access. */
  client: DaemonClient
  activityMonitor: ActivityMonitorPort
  activityRegistry: ActivityRegistry
  caffeine: TestCaffeineController
  notificationService: NotificationService
  notifications: NotificationBrokers
  notificationDeliveries: TestNotificationDelivery[]
  analysisInteractive: TestAnalysisInteractive
  dispose: () => Promise<void>
}

export interface TestAnalysisInteractive extends AnalysisInteractivePort {
  reportStarts: OpenReportInput[]
  marimoStarts: StartMarimoInput[]
  closes: Array<{ ownerId: string; leaseId: string }>
}

export function createTestAnalysisInteractive(): TestAnalysisInteractive {
  const reportStarts: OpenReportInput[] = []
  const marimoStarts: StartMarimoInput[] = []
  const closes: Array<{ ownerId: string; leaseId: string }> = []
  const generations = new Map<string, number>()
  const leases = new Map<string, string>()
  return {
    reportStarts,
    marimoStarts,
    closes,
    async begin(ownerId, leaseId): Promise<number> {
      const generation = (generations.get(ownerId) ?? 0) + 1
      generations.set(ownerId, generation)
      leases.set(ownerId, leaseId)
      return generation
    },
    async openReport(input): Promise<AnalysisInteractiveResult> {
      reportStarts.push(input)
      return { type: "html", url: "pi-lab-report://test/report.html" }
    },
    async startMarimo(input): Promise<AnalysisInteractiveResult> {
      marimoStarts.push(input)
      return { type: "marimo", url: "http://127.0.0.1:41000/", runtime: "Test Python" }
    },
    async close(ownerId, leaseId): Promise<void> {
      closes.push({ ownerId, leaseId })
      if (leases.get(ownerId) !== leaseId) return
      leases.delete(ownerId)
      generations.set(ownerId, (generations.get(ownerId) ?? 0) + 1)
    },
    dispose(): void {},
  }
}

export interface TestNotificationDelivery {
  input: NativeNotificationInput
  handlers: NativeNotificationHandlers
}

export interface TestCaffeineController extends CaffeineControllerPort {
  terminalActivityCount: number
  meaningfulTags: string[]
  meaningfulStartedTags: string[]
}

export function createTestCaffeineController(): TestCaffeineController {
  let settings: CaffeineSettings = { mode: "off", scope: "system-only" }
  const activeTags: string[] = []
  const startedTags: string[] = []
  return {
    terminalActivityCount: 0,
    meaningfulTags: activeTags,
    meaningfulStartedTags: startedTags,
    status: (): CaffeineStatus => ({ ...settings, held: settings.mode === "on" }),
    configure: (next): CaffeineStatus => {
      settings = { ...next }
      return { ...settings, held: settings.mode === "on" }
    },
    markTerminalActivity(): void {
      this.terminalActivityCount += 1
    },
    beginMeaningfulActivity(tag: string): () => void {
      activeTags.push(tag)
      startedTags.push(tag)
      return () => {
        const index = activeTags.indexOf(tag)
        if (index >= 0) activeTags.splice(index, 1)
      }
    },
  }
}

/**
 * A deterministic, network-free ssh probe for the cluster router's status tests
 * Every host is reachable unless its alias starts with `down-`,
 * so a suite can assert both branches without any real `ssh` / network.
 */
export const FAKE_SSH_EXEC: SshExec = async ({ host }) =>
  host.startsWith("down-")
    ? { ok: false, detail: "Connection refused" }
    : { ok: true, detail: "10:00 up 3 days" }

/**
 * Default outbound-HTTP fake for the harness: any unexpected URL is a hard error
 * so a test that hits the network by accident fails loudly rather than reaching
 * the real Zotero API. Library router suites pass their own `httpFetch` to stub
 * specific responses.
 */
export const FAKE_HTTP_FETCH: HttpFetch = async (input) => {
  throw new Error(`Unexpected network call in tests: ${String(input)}`)
}

/**
 * Default file-open fake for the harness: a no-op that reports success (empty string,
 * like `shell.openPath`) without touching the OS. The library router suite passes its
 * own to record which path `science.library.openItem` resolved.
 */
export const FAKE_OPEN_PATH: OpenPath = async () => ""

/**
 * Default Python-tools exec for the harness: reports every tool as **absent**
 * (`notFound: true`) so an unrelated router suite never spawns a real `uvx`
 * process. The diagnostics suite passes its own exec returning canned tool output
 * to exercise the parse + merge path.
 */
export const FAKE_PY_TOOLS_EXEC: PyToolsExec = async () => ({
  stdout: "",
  stderr: "",
  code: null,
  notFound: true,
})

export const FAKE_PYTHON_RUNTIME_RESOLVER: PythonRuntimeResolver = async () => ({
  source: null,
  displayName: "No virtual env",
  interpreterPath: process.execPath,
  runStrategy: { kind: "python", command: process.execPath, argsPrefix: [] },
})

export interface HarnessOptions {
  latexResourcesDir?: string
  latexDataDir?: string
  latexUserHome?: string
  resolveAgentExecutable?: AgentExecutableResolver
  appChannel?: PiLabChannel
  /** Skip Git subprocesses for suites that use only the database and filesystem. */
  git?: boolean
  /** Defer the real socket and its clients until a terminal operation needs them. */
  daemon?: "eager" | "lazy"
  /** Launchable agents for this harness (defaults to the single fake agent). */
  agentCatalog?: readonly TerminalAgent[]
  /** Reachability probe for the cluster router (defaults to {@link FAKE_SSH_EXEC}). */
  sshExec?: SshExec
  /** Outbound HTTP for the library router (defaults to {@link FAKE_HTTP_FETCH}). */
  httpFetch?: HttpFetch
  /** File-open for the library router's folder source (defaults to {@link FAKE_OPEN_PATH}). */
  openPath?: OpenPath
  revealPath?: (path: string) => void | Promise<void>
  /** Python-tools exec for the diagnostics router (defaults to {@link FAKE_PY_TOOLS_EXEC}). */
  pyToolsExec?: PyToolsExec
  /** Workspace Python resolver (defaults to a deterministic Node-backed runtime). */
  resolvePythonRuntime?: PythonRuntimeResolver
  /** Global Python environment discovery (defaults to no global environments). */
  discoverPythonEnvironments?: PythonEnvironmentDiscoverer
  /** One-shot workflow process runner (defaults to the production no-shell runner). */
  runNonInteractiveProcess?: NonInteractiveProcessRunner
  setupProbe?: SetupProbe
  /** Login-shell environment supplied to direct agent/workflow launches. */
  getAgentLaunchEnvironment?: AgentLaunchEnvironmentResolver
  /** Make the fake application focus adapter report another app in front. */
  notificationsUnfocused?: boolean
  /** Make the fake native platform accept and record notification delivery. */
  nativeNotificationsSupported?: boolean
}

/** Initialize a repo with one commit on `main`, deterministic identity. */
async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", dir])
  const run = (args: string[]) => execFileAsync("git", ["-C", dir, ...args])
  await run(["config", "user.email", "test@pi-lab.local"])
  await run(["config", "user.name", "PI Lab Test"])
  await writeFile(join(dir, "README.md"), "# fixture\n")
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

/**
 * Stand up a full router harness. `PI_LAB_DATA_DIR` is pointed at a temp dir so
 * managed worktrees and the DB both land there; the caller restores it in
 * `dispose`.
 */
export async function createHarness(
  agentCatalog: readonly TerminalAgent[] = [FAKE_AGENT],
  options: Pick<
    HarnessOptions,
    | "latexResourcesDir"
    | "latexDataDir"
    | "latexUserHome"
    | "resolveAgentExecutable"
    | "sshExec"
    | "httpFetch"
    | "openPath"
    | "revealPath"
    | "pyToolsExec"
    | "discoverPythonEnvironments"
    | "resolvePythonRuntime"
    | "notificationsUnfocused"
    | "nativeNotificationsSupported"
    | "runNonInteractiveProcess"
    | "setupProbe"
    | "getAgentLaunchEnvironment"
    | "git"
    | "daemon"
    | "appChannel"
  > = {},
): Promise<Harness> {
  // Canonicalize: on macOS `mkdtemp` hands back `/var/...` but git reports the
  // realpath `/private/var/...`; resolving here keeps repoPath assertions exact.
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), "pi-lab-rtr-")))
  const previousDataDir = process.env.PI_LAB_DATA_DIR
  process.env.PI_LAB_DATA_DIR = dataDir

  const repoDir = join(dataDir, "repo")
  if (options.git === false) await mkdir(repoDir)
  else await initRepo(repoDir)

  const dbPath = join(dataDir, "local.db")
  const { db, sqlite } = runMigrations(dbPath)

  const socketPath = join(dataDir, "daemon.sock")
  const server = new DaemonServer({ socketPath })
  const client = new DaemonClient(socketPath)
  const monitorClient = new DaemonClient(socketPath)
  let daemonStarting: Promise<void> | null = null
  const ensureDaemon = (): Promise<void> => {
    if (!daemonStarting) {
      daemonStarting = (async () => {
        await server.listen()
        await Promise.all([client.connect(), monitorClient.connect()])
      })()
    }
    return daemonStarting
  }
  if (options.daemon !== "lazy") await ensureDaemon()

  const notifications = createNotificationBrokers()
  const notificationDeliveries: TestNotificationDelivery[] = []
  const notificationService = new NotificationService({
    native: {
      isSupported: () => options.nativeNotificationsSupported ?? false,
      deliver: (input, handlers) => {
        notificationDeliveries.push({ input, handlers })
      },
    },
    focus: {
      isFocused: () => !(options.notificationsUnfocused ?? false),
      restoreAndFocus: () => {},
    },
    getPreferences: () => getSettingsOrDefaults(db).notifications,
    activations: notifications.activations,
    sounds: notifications.sounds,
    errors: notifications.errors,
    logger: { warn: () => {} },
  })
  const activityRegistry = new ActivityRegistry({
    clock: systemActivityClock,
    scheduler: systemActivityScheduler,
  })
  const activityMonitor = createActivityMonitor({
    db,
    registry: activityRegistry,
    getMonitorClient: async () => {
      await ensureDaemon()
      return monitorClient
    },
    notifications: notificationService,
    scheduler: systemActivityScheduler,
    logger: { warn: () => {} },
  })
  const caffeine = createTestCaffeineController()
  const analysisInteractive = createTestAnalysisInteractive()
  const skillsHomeDir = join(dataDir, "home")
  const context: AppContext = {
    db,
    appChannel: options.appChannel ?? "alpha",
    skillsHomeDir,
    latexResourcesDir: options.latexResourcesDir,
    latexDataDir: options.latexDataDir ?? join(dataDir, "latex"),
    latexUserHome: options.latexUserHome,
    getDaemonClient: async () => {
      await ensureDaemon()
      return client
    },
    agentCatalog,
    resolveAgentExecutable:
      options.resolveAgentExecutable ??
      (async (candidate) => (candidate === "/missing/pi-lab-agent" ? null : candidate)),
    getAgentLaunchEnvironment:
      options.getAgentLaunchEnvironment ??
      (async () => ({ ...process.env }) as Record<string, string>),
    runNonInteractiveProcess: options.runNonInteractiveProcess ?? runNonInteractiveProcess,
    setupProbe:
      options.setupProbe ?? (async () => ({ code: 1, stdout: "", stderr: "", timedOut: false })),
    credentialCipher: testCredentialCipher,
    sshExec: options.sshExec ?? FAKE_SSH_EXEC,
    httpFetch: options.httpFetch ?? FAKE_HTTP_FETCH,
    openPath: options.openPath ?? FAKE_OPEN_PATH,
    revealPath: options.revealPath ?? (() => {}),
    pyToolsExec: options.pyToolsExec ?? FAKE_PY_TOOLS_EXEC,
    discoverPythonEnvironments: options.discoverPythonEnvironments ?? (async () => []),
    resolvePythonRuntime: options.resolvePythonRuntime ?? FAKE_PYTHON_RUNTIME_RESOLVER,
    analysisInteractive,
    notifications,
    activityMonitor,
    activityStatus: new ActivityStatusFeed(db, activityRegistry),
    notificationService,
    caffeine,
    thumbnailImageProcessor: {
      inspect: () => ({
        width: 1,
        height: 1,
        badgeDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA=",
      }),
      inspectWebP: async () => null,
    },
  }
  const caller = createCaller(context)

  const dispose = async () => {
    activityMonitor.dispose()
    activityRegistry.dispose()
    if (daemonStarting) {
      await daemonStarting
      monitorClient.close()
      client.close()
      await server.close()
    }
    closeSqlite(sqlite)
    if (previousDataDir === undefined) delete process.env.PI_LAB_DATA_DIR
    else process.env.PI_LAB_DATA_DIR = previousDataDir
    await rm(dataDir, { recursive: true, force: true })
  }

  return {
    caller,
    db,
    dataDir,
    skillsHomeDir,
    repoDir,
    client,
    activityMonitor,
    activityRegistry,
    caffeine,
    notificationService,
    notifications,
    notificationDeliveries,
    analysisInteractive,
    dispose,
  }
}

/**
 * Initialize an additional throwaway git repo under the harness data dir and
 * return its canonical path — for tests that need a second project (e.g. proving
 * a concurrent agent in project A does not steer a start in project B onto a
 * worktree). The name namespaces it so multiple secondary repos don't collide.
 */
export async function makeRepo(dataDir: string, name = "repo2"): Promise<string> {
  const repoDir = join(dataDir, name)
  await initRepo(repoDir)
  // Canonicalize so repoPath assertions match git's realpath (macOS /private/var).
  return realpath(repoDir)
}

function closeSqlite(sqlite: Database.Database): void {
  try {
    sqlite.close()
  } catch {
    // Already closed — nothing to do.
  }
}
