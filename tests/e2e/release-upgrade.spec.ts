import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
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
 * Done check "Upgrade" (step 1 plan): an install made by the previous build
 * (one Electron process that owns the database) opens with the new build
 * (server split): its project and routine are still there, and the routine
 * runs exactly once. Set PI_LAB_PREVIOUS_MAIN_ENTRY to the previous build's
 * `out/main/index.js` (for example a build of `main`); skipped otherwise.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const desktopRequire = createRequire(join(DESKTOP_DIR, "package.json"))
const ELECTRON_PATH = desktopRequire("electron") as string
const Database = desktopRequire("better-sqlite3") as typeof import("better-sqlite3")
const execFileAsync = promisify(execFile)
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional previous-build verification.
const previousEntry = process.env.PI_LAB_PREVIOUS_MAIN_ENTRY

let dataDir: string
let repoDir: string
let app: ElectronApplication | null = null

function launch(entry: string, extra: Record<string, string>): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: ELECTRON_PATH,
    args: [entry],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: repoDir,
      ...extra,
    },
  })
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-release-upgrade-"))
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
  }
  await rm(dataDir, { recursive: true, force: true })
})

test("an install made by the previous build opens with the new build and runs its routine once", async () => {
  test.skip(!previousEntry, "PI_LAB_PREVIOUS_MAIN_ENTRY is not set")
  test.setTimeout(150_000)

  // The previous build: project and routine created through its own UI.
  app = await launch(previousEntry ?? "", {})
  const old = await app.firstWindow()
  await expect(old.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(old.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
  await old.getByTestId("nav-automations").click()
  await expect(old.getByTestId("new-automation")).toBeEnabled({ timeout: 30_000 })
  await old.getByTestId("new-automation").click()
  await old.getByTestId("automation-name-input").fill("Made by the old app")
  await old.getByTestId("automation-prompt").fill("write the marker")
  await old.getByTestId("automation-execution-mode").selectOption("noninteractive")
  await old.getByTestId("create-automation-submit").click()
  await expect(old.getByTestId("automation-row")).toBeVisible({ timeout: 30_000 })
  await app.close()
  app = null

  // Make the saved routine due soon and use the deterministic test agent of the new build.
  const startAt = Date.now() + 20_000
  const db = new Database(join(dataDir, "local.db"))
  const before = db.prepare("select id from projects").all() as { id: string }[]
  db.prepare(
    "update automations set agent_id = 'test-routine', recurrence_rule = 'FREQ=MINUTELY;COUNT=1', start_at = ?, next_run_at = ?",
  ).run(startAt, startAt)
  db.close()

  // The new build: same database, server split.
  app = await launch(MAIN_ENTRY, {
    PI_LAB_TEST_RETAIN_SERVER: "1",
    PI_LAB_TEST_SCHEDULER_INTERVAL_MS: "500",
  })
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const { client, close } = connectServer(dataDir)
  expect((await client.projects.list.query()).map((p) => p.id)).toEqual(before.map((p) => p.id))
  const [routine] = await client.automations.list.query()
  expect(routine?.name).toBe("Made by the old app")

  const marker = join(repoDir, "ROUTINE_RAN.txt")
  await expect.poll(() => existsSync(marker), { timeout: 60_000, intervals: [500] }).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  const runs = await client.automations.listRuns.query({ automationId: routine?.id ?? "" })
  expect(runs).toHaveLength(1)
  expect(runs[0]?.state).toBe("completed")
  close()
})
