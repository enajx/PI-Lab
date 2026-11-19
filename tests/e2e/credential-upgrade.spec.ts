import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
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
 * Done check "Upgrade" (step 1 plan): an API key saved by an older PI Lab
 * (encrypted with Electron safeStorage, here Chromium's test-mode mock key)
 * is moved to the server's secret store when the new app starts, and a
 * server-side operation can use it with Electron fully quit. The operation is
 * a non-interactive routine whose agent executable is a test script that
 * writes the API key variable it received into the project.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const desktopRequire = createRequire(join(DESKTOP_DIR, "package.json"))
const ELECTRON_PATH = desktopRequire("electron") as string
const Database = desktopRequire("better-sqlite3") as typeof import("better-sqlite3")
const execFileAsync = promisify(execFile)
const KEY = "sk-synthetic-upgrade-key"

let dataDir: string
let repoDir: string
let app: ElectronApplication | null = null

function launch(): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: repoDir,
      PI_LAB_TEST_RETAIN_SERVER: "1",
      PI_LAB_TEST_RETAIN_DAEMON: "1",
    },
  })
}

async function quit(running: ElectronApplication): Promise<void> {
  const pid = running.process().pid
  await running.close()
  if (pid) await expect.poll(() => processAlive(pid), { timeout: 15_000 }).toBe(false)
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-upgrade-"))
  repoDir = join(await realpath(dataDir), "repo")
  await execFileAsync("git", ["init", "-b", "main", repoDir])
  await writeFile(join(repoDir, "README.md"), "# fixture\n")
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

test("a key saved by the old app is moved at start and used by the server with Electron quit", async () => {
  test.setTimeout(120_000)
  app = await launch()
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  // What the old app wrote: a safeStorage value without the new format prefix.
  const legacy = await app.evaluate(
    ({ safeStorage }, key) => safeStorage.encryptString(key).toString("base64"),
    KEY,
  )
  const db = new Database(join(dataDir, "local.db"))
  db.prepare(
    "insert into agent_credentials (agent_id, encrypted_value, updated_at) values (?, ?, ?)",
  ).run("codex", legacy, Date.now())
  // A value the old app's key cannot read (Keychain reset, data from another Mac).
  db.prepare(
    "insert into agent_credentials (agent_id, encrypted_value, updated_at) values (?, ?, ?)",
  ).run("claude-code", "bm90IGEgc2FmZVN0b3JhZ2UgdmFsdWU=", Date.now())
  db.close()
  await quit(app)

  // The new app moves the key at its next start.
  app = await launch()
  await expect((await app.firstWindow()).getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const { client, close } = connectServer(dataDir)
  // The readable key is moved; the unreadable one stays and does not block startup.
  await expect
    .poll(async () => (await client.server.legacyCredentials.query()).map((row) => row.key), {
      timeout: 15_000,
    })
    .toEqual(["claude-code"])
  await quit(app)
  app = null

  // With Electron quit, a routine on the server decrypts and uses the key.
  const script = join(dataDir, "fake-codex.sh")
  await writeFile(script, '#!/bin/sh\nprintf "%s" "$CODEX_API_KEY" > KEY_SEEN.txt\n')
  await chmod(script, 0o755)
  await client.settings.updateAgents.mutate({
    executableOverrides: { codex: script },
    launchDefaults: { codex: { authMethod: "api-key" } },
  })
  const project = (await client.projects.list.query()).find((p) => p.repoPath === repoDir)
  expect(project).toBeDefined()
  const routine = await client.automations.create.mutate({
    projectId: project?.id ?? "",
    agentId: "codex",
    executionMode: "noninteractive",
    name: "Uses the key",
    prompt: "check",
    recurrenceRule: "FREQ=DAILY",
    timezone: "UTC",
    enabled: false,
  })
  await client.automations.runNow.mutate({ id: routine.id })
  await expect
    .poll(
      async () => {
        const [run] = await client.automations.listRuns.query({ automationId: routine.id })
        return run?.state === "failed" ? `failed: ${run.error}` : run?.state
      },
      { timeout: 30_000 },
    )
    .toBe("completed")
  const seen = join(repoDir, "KEY_SEEN.txt")
  await expect.poll(() => existsSync(seen), { timeout: 30_000 }).toBe(true)
  expect(await readFile(seen, "utf8")).toBe(KEY)
  close()
})
