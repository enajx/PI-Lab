import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  test,
} from "./fixtures/playwright"
import { connectServer, processAlive, readServerDiscovery } from "./fixtures/serverClient"

/**
 * Done check "server with every client off" (step 1 plan, PR 1): the PI Lab
 * server keeps running after Electron is fully quit. While no client is
 * connected a scheduled routine runs once and an agent exits; after the app
 * starts again it connects to the same server and the result, status and
 * project files are correct. Runs the built app in test mode with the
 * deterministic test agents (no paid agent, no network).
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional packaged Alpha verification.
const packagedBinary = process.env.PI_LAB_PACKAGED_BINARY
const execFileAsync = promisify(execFile)
const Database = createRequire(join(DESKTOP_DIR, "package.json"))(
  "better-sqlite3",
) as typeof import("better-sqlite3")

let dataDir: string
let repoDir: string
let app: ElectronApplication | null = null

async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", dir])
  const run = (args: string[]) => execFileAsync("git", ["-C", dir, ...args])
  await run(["config", "user.email", "test@pi-lab.local"])
  await run(["config", "user.name", "PI Lab Test"])
  await writeFile(join(dir, "README.md"), "# fixture\n")
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

function launch(): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: packagedBinary ?? ELECTRON_PATH,
    args: packagedBinary ? [] : [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: repoDir,
      PI_LAB_TEST_RETAIN_SERVER: "1",
      PI_LAB_TEST_RETAIN_DAEMON: "1",
      PI_LAB_TEST_SCHEDULER_INTERVAL_MS: "500",
    },
  })
}

/** Quit Electron completely and wait until its process is gone. */
async function quitElectron(running: ElectronApplication): Promise<void> {
  const pid = running.process().pid
  await running.close()
  if (pid) await expect.poll(() => processAlive(pid), { timeout: 15_000 }).toBe(false)
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-server-off-"))
  repoDir = join(await realpath(dataDir), "repo")
  await initRepo(repoDir)
})

test.afterEach(async () => {
  if (app) await app.close().catch(() => undefined)
  app = null
  const discovery = readServerDiscovery(dataDir)
  if (discovery && processAlive(discovery.pid)) {
    const { client, close } = connectServer(dataDir)
    await client.server.stop.mutate({ stopAgents: true }).catch(() => undefined)
    close()
    await expect.poll(() => processAlive(discovery.pid), { timeout: 15_000 }).toBe(false)
  }
  await rm(dataDir, { recursive: true, force: true })
})

test("routine runs and agent exit is recorded while Electron is fully quit", async () => {
  test.setTimeout(180_000)
  app = await launch()
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })

  const before = readServerDiscovery(dataDir)
  expect(before).not.toBeNull()
  const serverPid = before?.pid ?? 0
  expect(processAlive(serverPid)).toBe(true)

  const first = connectServer(dataDir)
  const project = (await first.client.projects.list.query()).find((p) => p.repoPath === repoDir)
  expect(project).toBeDefined()
  const projectId = project?.id ?? ""

  // The routine fires a few seconds after Electron has quit.
  const automation = await first.client.automations.create.mutate({
    projectId,
    agentId: "test-routine",
    executionMode: "noninteractive",
    name: "While away",
    prompt: "write the marker",
    recurrenceRule: "FREQ=MINUTELY;COUNT=1",
    startAt: Date.now() + 12_000,
    timezone: "UTC",
  })
  // The agent prints, waits, then exits while no client is connected.
  const started = await first.client.sessions.start.mutate({
    projectId,
    agentId: "test-exit-later",
    origin: "project",
    workspaceMode: "main",
  })
  first.close()

  await quitElectron(app)
  app = null
  const quitAt = Date.now()
  expect(processAlive(serverPid)).toBe(true)

  // Nothing but the server (and its PTY daemon) runs now.
  const marker = join(repoDir, "ROUTINE_RAN.txt")
  await expect.poll(() => existsSync(marker), { timeout: 60_000, intervals: [500] }).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 8_000))
  expect(processAlive(serverPid)).toBe(true)

  app = await launch()
  const again = await app.firstWindow()
  await expect(again.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  expect(readServerDiscovery(dataDir)?.pid).toBe(serverPid)

  const second = connectServer(dataDir)
  const runs = await second.client.automations.listRuns.query({ automationId: automation.id })
  expect(runs).toHaveLength(1)
  expect(runs[0]?.state).toBe("completed")
  expect(await readFile(marker, "utf8")).toContain("routine ran")

  second.close()

  // The agent's exit was recorded by the server while Electron was quit.
  const db = new Database(join(dataDir, "local.db"), { readonly: true })
  const session = db
    .prepare("select state, exited_at as exitedAt from agent_sessions where session_id = ?")
    .get(started.sessionId) as { state: string; exitedAt: number | null } | undefined
  db.close()
  expect(session?.state).toBe("exited")
  expect(session?.exitedAt ?? 0).toBeGreaterThan(quitAt)
})

test("an open app reconnects after the server restarts on a new port", async () => {
  test.setTimeout(120_000)
  app = await launch()
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const before = readServerDiscovery(dataDir)
  if (!before) throw new Error("no server.json")

  // A crash, then a restart as launchd would do it (same environment, new port).
  process.kill(before.pid, "SIGKILL")
  await expect.poll(() => processAlive(before.pid), { timeout: 10_000 }).toBe(false)
  const serverEntry = join(DESKTOP_DIR, "out", "main", "server.js")
  const restarted = spawn(ELECTRON_PATH, [serverEntry], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PI_LAB_TEST_MODE: "1",
      PI_LAB_CHANNEL: "alpha",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_PACKAGED: "0",
      PI_LAB_RESOURCES_DIR: join(DESKTOP_DIR, "resources"),
      PI_LAB_BUILD: createHash("sha256")
        .update(readFileSync(serverEntry))
        .digest("hex")
        .slice(0, 16),
      PI_LAB_VERSION: "0.0.0",
      PI_LAB_SERVER_PORT: "0",
    },
  })
  restarted.unref()
  await expect
    .poll(
      () => {
        const now = readServerDiscovery(dataDir)
        return now !== null && now.pid !== before.pid && processAlive(now.pid)
      },
      { timeout: 30_000 },
    )
    .toBe(true)

  const after = readServerDiscovery(dataDir)
  expect(after?.port).not.toBe(before.port)

  // A routine created on the new server shows in the same window, without a reload.
  const fresh = connectServer(dataDir)
  const project = (await fresh.client.projects.list.query()).find((p) => p.repoPath === repoDir)
  await fresh.client.automations.create.mutate({
    projectId: project?.id ?? "",
    agentId: "test-routine",
    executionMode: "noninteractive",
    name: "After restart",
    prompt: "x",
    recurrenceRule: "FREQ=DAILY",
    timezone: "UTC",
    enabled: false,
  })
  fresh.close()
  await window.getByTestId("nav-automations").click()
  await expect(window.getByTestId("automation-name")).toContainText("After restart", {
    timeout: 30_000,
  })
})

test("the built server bundle loads no Electron module", () => {
  // Under ELECTRON_RUN_AS_NODE, require("electron") returns a path string and
  // fails later without an error, so check the built files themselves.
  const outDir = join(DESKTOP_DIR, "out", "main")
  const seen = new Set<string>()
  const visit = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    const code = readFileSync(join(outDir, file), "utf8")
    expect(code, `${file} loads electron`).not.toMatch(
      /require\(["']electron["']\)|from ["']electron["']/,
    )
    for (const match of code.matchAll(/require\(["']\.\/([^"']+\.js)["']\)/g)) visit(match[1] ?? "")
  }
  visit("server.js")
  expect(seen.size).toBeGreaterThan(1)
})
