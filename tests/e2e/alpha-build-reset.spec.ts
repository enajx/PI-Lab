import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test"

const desktop = resolve("apps/desktop")
const desktopRequire = createRequire(join(desktop, "package.json"))
const Database = desktopRequire("better-sqlite3")
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Direct packaged check outside Turbo.
const binary = process.env.PI_LAB_PACKAGED_BINARY

/** Launch the real packaged Alpha with a disposable profile and optional project registration. */
async function launch(dataDir: string, project: string | null): Promise<ElectronApplication> {
  if (!binary) throw new Error("PI_LAB_PACKAGED_BINARY is required")
  return electron.launch({
    executablePath: binary,
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

/** Close only this test instance and its test-mode daemon. */
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

/** Observe boot through the actual renderer and IPC, then open database-backed preferences. */
async function settings(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await page.getByTestId("nav-settings").click()
  await page.getByTestId("settings-nav-general").click()
  return page
}

/** Read only the remembered-project count while the app owns its database. */
function rememberedProjects(dataDir: string): number {
  const db = new Database(join(dataDir, "local.db"), { readonly: true })
  const count = db.prepare("SELECT COUNT(*) AS count FROM projects").get().count as number
  db.close()
  return count
}

/** Real Electron/SQLite: simulate an earlier build marker, without changing packaged identity. */
test("new Alpha build resets its database once and preserves projects on disk and compiler cache", async () => {
  test.skip(!binary, "Requires a packaged Alpha binary")
  test.setTimeout(90_000)
  const root = await mkdtemp(join(tmpdir(), "pi-lab-alpha-reset-e2e-"))
  const data = join(root, "data")
  const project = join(root, "paper")
  await mkdir(project)
  await mkdir(join(data, "latex", "cache"), { recursive: true })
  await writeFile(join(project, "paper.tex"), "Project file must survive.\n")
  await writeFile(join(data, "latex", "cache", "fixture"), "Compiler cache must survive.\n")
  let app: ElectronApplication | null = null
  try {
    app = await launch(data, project)
    let page = await settings(app)
    await page.getByTestId("settings-keep-running-after-close").click()
    await expect(page.getByTestId("settings-keep-running-after-close")).toHaveAttribute(
      "aria-checked",
      "false",
    )
    await close(app)
    app = null
    await writeFile(
      join(data, "alpha-build.json"),
      JSON.stringify({ buildId: "previous-alpha-build" }),
    )

    app = await launch(data, null)
    page = await settings(app)
    await expect(page.getByTestId("settings-keep-running-after-close")).toHaveAttribute(
      "aria-checked",
      "true",
    )
    expect(rememberedProjects(data)).toBe(0)
    const archives = await readdir(join(data, "alpha-db-archives"))
    expect(archives).toHaveLength(1)
    const archived = new Database(join(data, "alpha-db-archives", archives[0], "local.db"), {
      readonly: true,
    })
    expect(archived.prepare("SELECT COUNT(*) AS count FROM projects").get().count).toBe(1)
    expect(
      archived.prepare("SELECT keep_running_after_close AS saved FROM settings WHERE id=1").get()
        .saved,
    ).toBe(0)
    archived.close()
    expect(await readFile(join(project, "paper.tex"), "utf8")).toBe("Project file must survive.\n")
    expect(await readFile(join(data, "latex", "cache", "fixture"), "utf8")).toBe(
      "Compiler cache must survive.\n",
    )
    await page.getByTestId("settings-keep-running-after-close").click()
    await expect(page.getByTestId("settings-keep-running-after-close")).toHaveAttribute(
      "aria-checked",
      "false",
    )
    await close(app)
    app = null

    app = await launch(data, project)
    page = await settings(app)
    await expect(page.getByTestId("settings-keep-running-after-close")).toHaveAttribute(
      "aria-checked",
      "false",
    )
    await page.getByTestId("settings-back").click()
    await expect(page.getByTestId("project-item")).toHaveCount(1)
    expect(await readdir(join(data, "alpha-db-archives"))).toHaveLength(1)
    await close(app)
    app = null

    // A previous feature build can have a migration journal this build cannot read.
    const previous = new Database(join(data, "local.db"))
    previous
      .prepare(
        "UPDATE __drizzle_migrations SET hash = ? WHERE rowid = (SELECT MAX(rowid) FROM __drizzle_migrations)",
      )
      .run("unrecognized-feature-migration")
    previous.close()
    await writeFile(
      join(data, "alpha-build.json"),
      JSON.stringify({ buildId: "incompatible-feature-build" }),
    )
    app = await launch(data, null)
    page = await settings(app)
    await expect(page.getByTestId("settings-keep-running-after-close")).toHaveAttribute(
      "aria-checked",
      "true",
    )
    expect(rememberedProjects(data)).toBe(0)
    const saved = await readdir(join(data, "alpha-db-archives"))
    expect(saved).toHaveLength(2)
    const other = saved.find((name) => name !== archives[0])
    if (!other) throw new Error("Expected an archive for the incompatible database")
    const incompatible = new Database(join(data, "alpha-db-archives", other, "local.db"), {
      readonly: true,
    })
    expect(
      incompatible
        .prepare("SELECT hash FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1")
        .get().hash,
    ).toBe("unrecognized-feature-migration")
    incompatible.close()
  } finally {
    if (app) await close(app)
    await rm(root, { recursive: true, force: true })
  }
})
