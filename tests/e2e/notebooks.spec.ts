import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  test,
} from "./fixtures/playwright"

/**
 * Whole-app E2E for notebook tabs: Open notebook on an .ipynb in Analysis starts a
 * Jupyter server and shows it in a tab; closing the tab stops the server.
 *
 * The project has no Python environment, so PI Lab runs a PI Lab copy of Jupyter
 * through `uvx`. A STAND-IN `uvx` on PATH runs tests/e2e/fixtures/notebook-server.cjs,
 * which prints its URL the way Jupyter does and serves a small page. No real uv or
 * Jupyter runs here. Runs under Node (Playwright's `_electron` launcher hangs under Bun).
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string
const SERVER_FIXTURE = join(HERE, "fixtures", "notebook-server.cjs")
const execFileAsync = promisify(execFile)

let app: ElectronApplication
let appClosed: boolean
let dataDir: string
let markerPath: string

/** True while the process exists; signal 0 only checks. */
function alive(pid: number): boolean {
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-notebooks-"))
  const repoDir = join(dataDir, "repo")
  const binDir = join(dataDir, "bin")
  markerPath = join(dataDir, "notebook-server.log")
  await mkdir(join(repoDir, "results", "run"), { recursive: true })
  await mkdir(binDir)
  await execFileAsync("git", ["init", "-b", "main", repoDir])
  await writeFile(
    join(repoDir, "results", "run", "analysis.ipynb"),
    JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }),
  )
  // Stand-in uvx: runs the stand-in server with the arguments PI Lab passes to uvx.
  const uvx = join(binDir, "uvx")
  await writeFile(uvx, `#!/bin/sh\nexec "${process.execPath}" "${SERVER_FIXTURE}" "$@"\n`)
  await chmod(uvx, 0o755)
  appClosed = false
  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: repoDir,
      PI_LAB_TEST_NOTEBOOK_MARKER: markerPath,
    },
  })
})

test.afterEach(async () => {
  if (!appClosed) await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

/** Open the Analysis notebook in a tab and return the stand-in server's pid. */
async function openNotebookTab(): Promise<number> {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  await window
    .locator('[data-testid="analysis-file"][data-rel-path="results/run/analysis.ipynb"]')
    .click()
  await window.getByTestId("analysis-open-notebook").click()
  const page = window.frameLocator('[data-testid="notebook-frame"]')
  await expect(page.locator("#notebook-stand-in")).toBeVisible({ timeout: 30_000 })
  return Number(/^start:(\d+)$/m.exec(await readFile(markerPath, "utf8"))?.[1])
}

test("quitting PI Lab stops a notebook tab's server, even when the notebook page asks before unloading (stand-in uvx)", async () => {
  const pid = await openNotebookTab()
  // A click in the page lets its beforeunload handler take effect, as in a used JupyterLab.
  await (await app.firstWindow())
    .frameLocator('[data-testid="notebook-frame"]')
    .locator("#notebook-edit")
    .click()
  expect(alive(pid)).toBe(true)
  // Quit from the main process like the app menu does. Playwright still reports the
  // page's beforeunload as a dialog; PI Lab ignores it, so the test leaves it alone
  // (Playwright's own answer would fail on the closed window).
  ;(await app.firstWindow()).on("dialog", () => undefined)
  const closed = new Promise<void>((resolveClosed) => app.once("close", () => resolveClosed()))
  await app.evaluate(({ app: electronApp }) => electronApp.quit())
  await closed
  appClosed = true
  await expect.poll(() => alive(pid)).toBe(false)
})

test("Open notebook runs a Jupyter server in a tab, and closing the tab stops it (stand-in uvx)", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  await expect(window.getByTestId("science-analysis")).toBeVisible({ timeout: 30_000 })

  await window
    .locator('[data-testid="analysis-file"][data-rel-path="results/run/analysis.ipynb"]')
    .click()
  await window.getByTestId("analysis-open-notebook").click()

  const tab = window.locator('[data-testid="central-tab"][data-tab-kind="notebook"]')
  await expect(tab).toContainText("analysis.ipynb", { timeout: 30_000 })
  const page = window.frameLocator('[data-testid="notebook-frame"]')
  await expect(page.locator("#notebook-stand-in")).toBeVisible({ timeout: 30_000 })
  await expect(page.locator("#notebook-path")).toContainText(
    "/lab/tree/results/run/analysis.ipynb?token=",
  )
  await expect(window.getByTestId("notebook-environment")).toContainText("PI Lab copy (uvx)")

  const log = await readFile(markerPath, "utf8")
  const pid = Number(/^start:(\d+)$/m.exec(log)?.[1])
  expect(alive(pid)).toBe(true)
  const args = JSON.parse(/^args:(.*)$/m.exec(log)?.[1] ?? "[]") as string[]
  expect(args.slice(0, 4)).toEqual(["--from", "jupyterlab", "jupyter", "lab"])
  expect(args).toContain("--ServerApp.ip=127.0.0.1")

  await tab.getByTestId("central-tab-close").click()
  await expect(tab).toHaveCount(0)
  await expect.poll(async () => readFile(markerPath, "utf8")).toContain(`stop:${pid}`)
  await expect.poll(() => alive(pid)).toBe(false)
})
