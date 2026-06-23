// Shared test plumbing for the projects/workspaces router suites (AGENTS.md
// §14): a `createCaller` over a temp-file SQLite handle with the *real* generated
// migrations, a throwaway git repo, an in-process pty-daemon, and an injectable
// fake agent catalog. Everything is created with real tools (git init, real
// DaemonServer) — only the transport (caller vs IPC) and the daemon's home
// (in-process vs detached child) are substituted.

import { execFile } from "node:child_process"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { runMigrations, type SkipperDatabase } from "@skipper/local-db"
import { DaemonClient, DaemonServer } from "@skipper/pty-daemon"
import type { TerminalAgent } from "@skipper/shared"
import type Database from "better-sqlite3"
import type { PyToolsExec } from "../diagnostics"
import type { SshExec } from "../lib/ssh-config"
import { LiveAgentRegistry } from "../sessions/liveAgentRegistry"
import { appRouter } from "./appRouter"
import type { AppContext, HttpFetch } from "./context"
import { createCallerFactory } from "./trpc"

const execFileAsync = promisify(execFile)
const createCaller = createCallerFactory(appRouter)

export type Caller = ReturnType<typeof createCaller>

/**
 * A deterministic, credential-free fake agent (AGENTS.md §14): it runs the test
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
 * second concurrent agent (exercising the §8 concurrency-spills-to-worktree
 * branch of the policy). Killing the PTY (or closing the daemon) ends it.
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
  db: SkipperDatabase
  /** Data dir backing the DB and managed worktrees (honored by the routers). */
  dataDir: string
  /** A throwaway git repo with one commit on `main`. */
  repoDir: string
  client: DaemonClient
  /** The per-project live-agent tally the start-agent-session policy reads. */
  liveAgents: LiveAgentRegistry
  dispose: () => Promise<void>
}

/**
 * A deterministic, network-free ssh probe for the cluster router's status tests
 * (AGENTS.md §14): every host is reachable unless its alias starts with `down-`,
 * so a suite can assert both branches without any real `ssh` / network.
 */
export const FAKE_SSH_EXEC: SshExec = async (host) =>
  host.startsWith("down-")
    ? { ok: false, detail: "Connection refused" }
    : { ok: true, detail: "10:00 up 3 days" }

/**
 * Default outbound-HTTP fake for the harness: any unexpected URL is a hard error
 * so a test that hits the network by accident fails loudly rather than reaching
 * the real Zotero / Semantic Scholar APIs. Library router suites pass their own
 * `httpFetch` to stub specific responses (AGENTS.md §14).
 */
export const FAKE_HTTP_FETCH: HttpFetch = async (input) => {
  throw new Error(`Unexpected network call in tests: ${String(input)}`)
}

/**
 * Default Python-tools exec for the harness: reports every tool as **absent**
 * (`notFound: true`) so an unrelated router suite never spawns a real `uvx`
 * process. The diagnostics suite passes its own exec returning canned tool output
 * to exercise the parse + merge path (AGENTS.md §14).
 */
export const FAKE_PY_TOOLS_EXEC: PyToolsExec = async () => ({
  stdout: "",
  stderr: "",
  code: null,
  notFound: true,
})

export interface HarnessOptions {
  /** Launchable agents for this harness (defaults to the single fake agent). */
  agentCatalog?: readonly TerminalAgent[]
  /** Reachability probe for the cluster router (defaults to {@link FAKE_SSH_EXEC}). */
  sshExec?: SshExec
  /** Outbound HTTP for the library router (defaults to {@link FAKE_HTTP_FETCH}). */
  httpFetch?: HttpFetch
  /** Python-tools exec for the diagnostics router (defaults to {@link FAKE_PY_TOOLS_EXEC}). */
  pyToolsExec?: PyToolsExec
}

/** Initialize a repo with one commit on `main`, deterministic identity. */
async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", dir])
  const run = (args: string[]) => execFileAsync("git", ["-C", dir, ...args])
  await run(["config", "user.email", "test@skipper.local"])
  await run(["config", "user.name", "Skipper Test"])
  await writeFile(join(dir, "README.md"), "# fixture\n")
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

/**
 * Stand up a full router harness. `SKIPPER_DATA_DIR` is pointed at a temp dir so
 * managed worktrees and the DB both land there; the caller restores it in
 * `dispose`.
 */
export async function createHarness(
  agentCatalog: readonly TerminalAgent[] = [FAKE_AGENT],
  options: Pick<HarnessOptions, "sshExec" | "httpFetch" | "pyToolsExec"> = {},
): Promise<Harness> {
  // Canonicalize: on macOS `mkdtemp` hands back `/var/...` but git reports the
  // realpath `/private/var/...`; resolving here keeps repoPath assertions exact.
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), "skipper-rtr-")))
  const previousDataDir = process.env.SKIPPER_DATA_DIR
  process.env.SKIPPER_DATA_DIR = dataDir

  const repoDir = join(dataDir, "repo")
  await initRepo(repoDir)

  const dbPath = join(dataDir, "local.db")
  const { db, sqlite } = runMigrations(dbPath)

  const socketPath = join(dataDir, "daemon.sock")
  const server = new DaemonServer({ socketPath })
  await server.listen()
  const client = new DaemonClient(socketPath)
  await client.connect()

  const liveAgents = new LiveAgentRegistry()
  const context: AppContext = {
    db,
    getDaemonClient: async () => client,
    agentCatalog,
    liveAgents,
    sshExec: options.sshExec ?? FAKE_SSH_EXEC,
    httpFetch: options.httpFetch ?? FAKE_HTTP_FETCH,
    pyToolsExec: options.pyToolsExec ?? FAKE_PY_TOOLS_EXEC,
  }
  const caller = createCaller(context)

  const dispose = async () => {
    liveAgents.detach(client)
    client.close()
    await server.close()
    closeSqlite(sqlite)
    if (previousDataDir === undefined) delete process.env.SKIPPER_DATA_DIR
    else process.env.SKIPPER_DATA_DIR = previousDataDir
    await rm(dataDir, { recursive: true, force: true })
  }

  return { caller, db, dataDir, repoDir, client, liveAgents, dispose }
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
