import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "./fixtures/playwright"

const desktopRequire = createRequire(resolve("apps/desktop/package.json"))
const Database = desktopRequire("better-sqlite3")
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Direct packaged release check outside Turbo.
const previousBinary = process.env.PI_LAB_PREVIOUS_BETA_BINARY
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Direct packaged release check outside Turbo.
const candidateBinary = process.env.PI_LAB_PACKAGED_BETA_BINARY
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional expected release version supplied by Prepare Beta.
const expectedVersion = process.env.PI_LAB_EXPECTED_BETA_VERSION

/** Run a real packaged public app against only this test's profile and project. */
async function launch(
  executablePath: string,
  dataDir: string,
  project: string | null,
): Promise<ElectronApplication> {
  return electron.launch({
    executablePath,
    args: [],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_TEST_HIDE_WINDOWS: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: project ?? "",
    },
  })
}

/** Stop only the test app; its test-mode daemon is reaped during disposal. */
async function close(app: ElectronApplication): Promise<void> {
  const process = app.process()
  const forceExit = setTimeout(() => process.kill("SIGKILL"), 5_000)
  await app
    .evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy()
    })
    .catch(() => undefined)
  await app.close().catch(() => process.kill("SIGKILL"))
  clearTimeout(forceExit)
}

/** Open database-backed preferences through the app's actual renderer and IPC. */
async function generalSettings(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await page.getByTestId("nav-settings").click()
  await page.getByTestId("settings-nav-general").click()
  return page
}

/** Read the real profile without writing through a test-only database connection. */
function profile(dataDir: string): {
  projects: Array<{ id: string; repoPath: string }>
  keepRunningAfterClose: number
} {
  const sqlite = new Database(join(dataDir, "local.db"), { readonly: true })
  const projects = sqlite
    .prepare("SELECT id, repo_path AS repoPath FROM projects ORDER BY id")
    .all() as Array<{ id: string; repoPath: string }>
  const settings = sqlite
    .prepare("SELECT keep_running_after_close AS value FROM settings WHERE id=1")
    .get() as { value: number }
  sqlite.close()
  return { projects, keepRunningAfterClose: settings.value }
}

/** This verifies a previous Beta profile upgrade, not Squirrel download or installation. */
test("packaged Beta preserves the previous Beta's projects and settings", async () => {
  test.skip(!previousBinary || !candidateBinary, "Requires previous and candidate Beta binaries")
  test.setTimeout(90_000)
  if (!previousBinary || !candidateBinary) throw new Error("Both Beta binaries are required")
  const root = await mkdtemp(join(tmpdir(), "pi-lab-beta-profile-upgrade-"))
  const dataDir = join(root, "profile")
  const project = join(root, "real-project")
  const content = "Project files belong to the user.\n"
  await mkdir(project)
  await writeFile(join(project, "notes.txt"), content)
  let app: ElectronApplication | null = null
  try {
    app = await launch(previousBinary, dataDir, project)
    const previousVersion = await app.evaluate(({ app }) => app.getVersion())
    expect(previousVersion).toMatch(/-beta\./)
    let page = await generalSettings(app)
    const keepRunning = page.getByTestId("settings-keep-running-after-close")
    await expect(keepRunning).toHaveAttribute("aria-checked", "true")
    await keepRunning.click()
    await expect(keepRunning).toHaveAttribute("aria-checked", "false")
    await page.getByTestId("settings-back").click()
    await expect(page.getByTestId("project-item")).toHaveCount(1)
    await close(app)
    app = null
    const before = profile(dataDir)
    expect(before.projects).toHaveLength(1)
    expect(before.projects[0]?.repoPath).toBe(await realpath(project))
    expect(before.keepRunningAfterClose).toBe(0)

    // No project registration flag is passed: the candidate must read the saved record.
    app = await launch(candidateBinary, dataDir, null)
    const candidateVersion = await app.evaluate(({ app }) => app.getVersion())
    expect(candidateVersion).toMatch(/-beta\./)
    if (expectedVersion) expect(candidateVersion).toBe(expectedVersion)
    expect(candidateVersion).not.toBe(previousVersion)
    page = await generalSettings(app)
    await expect(page.getByTestId("settings-keep-running-after-close")).toHaveAttribute(
      "aria-checked",
      "false",
    )
    await page.getByTestId("settings-back").click()
    await expect(page.getByTestId("project-item")).toHaveCount(1)
    expect(profile(dataDir)).toEqual(before)
    expect(await readFile(join(project, "notes.txt"), "utf8")).toBe(content)
  } finally {
    if (app) await close(app)
    await rm(root, { recursive: true, force: true })
  }
})
