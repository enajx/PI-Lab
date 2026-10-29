import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  test,
} from "./fixtures/playwright"

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone Playwright runs are not cached by Turbo.
const MAIN_ENTRY = process.env.PI_LAB_E2E_MAIN_ENTRY ?? join(DESKTOP_DIR, "out", "main", "index.js")
const desktopRequire = createRequire(join(DESKTOP_DIR, "package.json"))
const ELECTRON_PATH = desktopRequire("electron") as string
const Database = desktopRequire("better-sqlite3") as typeof import("better-sqlite3")
type Sqlite = InstanceType<typeof Database>

const COMPLETED_SESSIONS = 24
const ACTIVE_SESSIONS = 3

/** Make the real project and worktree launch paths available to the Electron app. */
async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", dir])
  const git = (args: string[]) => execFileAsync("git", ["-C", dir, ...args])
  await git(["config", "user.email", "test@pi-lab.local"])
  await git(["config", "user.name", "PI Lab Test"])
  await writeFile(join(dir, "README.md"), "# Activity persistence fixture\n")
  await git(["add", "."])
  await git(["commit", "-m", "initial"])
}

/** Count durable session rows through a second connection to the app's real SQLite file. */
function countSessions(sqlite: Sqlite, state: "exited" | "live"): number {
  const condition = state === "exited" ? "state = 'exited'" : "state <> 'exited'"
  const row = sqlite
    .prepare(`SELECT count(*) AS count FROM agent_sessions WHERE ${condition}`)
    .get() as {
    count: number
  }
  return row.count
}

/** Launch through the same project UI used for normal interactive agents. */
async function startAgent(
  window: Awaited<ReturnType<ElectronApplication["firstWindow"]>>,
  label: "Test Echo" | "Test Activity",
  worktree: boolean,
): Promise<void> {
  await window.getByTestId("central-add-menu").click()
  await window.getByTestId("central-add-agent").click()
  const chooser = window.getByTestId("new-agent-dialog")
  await expect(chooser).toBeVisible()
  await chooser.getByLabel(label).locator("..").click()
  await expect(chooser.getByLabel(label)).toBeChecked()
  if (worktree) {
    await chooser.getByLabel("Worktree").locator("..").click()
    await expect(chooser.getByLabel("Worktree")).toBeChecked()
  }
  await chooser.getByRole("button", { name: "Start agent" }).click()
  await expect(chooser).toBeHidden({ timeout: 30_000 })
}

test("active output does not rewrite completed sessions in the real app", async () => {
  test.setTimeout(240_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-activity-"))
  const repoDir = join(dataDir, "repo")
  let app: ElectronApplication | null = null
  let sqlite: Sqlite | null = null

  try {
    await initRepo(repoDir)
    app = await electron.launch({
      executablePath: ELECTRON_PATH,
      args: [MAIN_ENTRY],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: dataDir,
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
        PI_LAB_TEST_OPEN_PROJECT: repoDir,
        PI_LAB_TEST_AGENT_ID: "test-echo",
      },
    })
    const window = await app.firstWindow()
    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await window.getByTestId("project-card").click()
    await expect(window.getByTestId("project-view")).toBeVisible()

    sqlite = new Database(join(dataDir, "local.db"))
    sqlite.pragma("busy_timeout = 5000")
    for (let count = 1; count <= COMPLETED_SESSIONS; count += 1) {
      await startAgent(window, "Test Echo", false)
      await expect
        .poll(() => countSessions(sqlite as Sqlite, "exited"), { timeout: 30_000 })
        .toBe(count)
    }

    for (let count = 1; count <= ACTIVE_SESSIONS; count += 1) {
      await startAgent(window, "Test Activity", true)
      await expect
        .poll(() => countSessions(sqlite as Sqlite, "live"), { timeout: 30_000 })
        .toBe(count)
    }
    await expect(window.locator('[data-testid="terminal"]:visible')).toContainText("AGENT-ACTIVE", {
      timeout: 30_000,
    })

    // Install only after boot and launches. The throwaway database never needs
    // another migration check, and each row logs an actual main-process UPDATE.
    sqlite.exec(`
      CREATE TABLE activity_write_probe (
        session_id TEXT NOT NULL,
        old_state TEXT NOT NULL,
        new_state TEXT NOT NULL
      );
      CREATE TRIGGER activity_write_probe_trigger AFTER UPDATE ON agent_sessions
      BEGIN
        INSERT INTO activity_write_probe (session_id, old_state, new_state)
        VALUES (NEW.session_id, OLD.state, NEW.state);
      END;
    `)

    // A real Playwright → Electron-main round trip while three PTYs stream output.
    const roundTripMs: number[] = []
    const sampleStart = performance.now()
    while (performance.now() - sampleStart < 2_200) {
      const started = performance.now()
      await app.evaluate(() => process.uptime())
      roundTripMs.push(performance.now() - started)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    const counts = sqlite
      .prepare("SELECT old_state, count(*) AS count FROM activity_write_probe GROUP BY old_state")
      .all() as Array<{ old_state: string; count: number }>
    const exitedWrites = counts.find((row) => row.old_state === "exited")?.count ?? 0
    const activeWrites = counts
      .filter((row) => row.old_state !== "exited")
      .reduce((sum, row) => sum + row.count, 0)
    const sortedMs = [...roundTripMs].sort((left, right) => left - right)
    const mainSha256 = createHash("sha256")
      .update(await readFile(MAIN_ENTRY))
      .digest("hex")
    await test.info().attach("activity-persistence-measurement.json", {
      body: Buffer.from(
        JSON.stringify(
          {
            mainEntry: MAIN_ENTRY,
            mainSha256,
            completedSessions: countSessions(sqlite, "exited"),
            activeSessions: countSessions(sqlite, "live"),
            sampleDurationMs: performance.now() - sampleStart,
            exitedWrites,
            activeWrites,
            mainRoundTripMs: roundTripMs,
            mainRoundTripMedianMs: sortedMs[Math.floor(sortedMs.length / 2)],
            mainRoundTripRangeMs: [sortedMs[0], sortedMs.at(-1)],
          },
          null,
          2,
        ),
      ),
      contentType: "application/json",
    })

    expect(roundTripMs.length).toBeGreaterThanOrEqual(5)
    expect(Math.max(...roundTripMs)).toBeLessThan(5_000)
    expect(countSessions(sqlite, "exited")).toBe(COMPLETED_SESSIONS)
    expect(countSessions(sqlite, "live")).toBe(ACTIVE_SESSIONS)
    expect(exitedWrites).toBe(0)
    expect(activeWrites).toBeGreaterThan(0)
    expect(activeWrites).toBeLessThanOrEqual(12)
  } finally {
    sqlite?.close()
    if (app) {
      // The test-mode dialog responder answers the quit confirmation with Quit.
      let forced = false
      const timeout = setTimeout(() => {
        forced = true
        app?.process().kill("SIGKILL")
      }, 10_000)
      try {
        await app.close()
        expect(forced, "Activity fixture should quit cleanly within ten seconds").toBe(false)
      } finally {
        clearTimeout(timeout)
      }
    }
    await rm(dataDir, { recursive: true, force: true })
  }
})
