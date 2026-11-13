import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { openAnalysisExperiment } from "./fixtures/analysis"
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
  // An HTML report whose script tries to reach a server: probe(url) answers "reached" or "blocked".
  await writeFile(
    join(repoDir, "results", "run", "probe.html"),
    `<!doctype html><p id="ready">Probe report</p><script>
window.probe = (url) => fetch(url, { mode: "no-cors", credentials: "include" }).then(() => "reached", () => "blocked")
</script>`,
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
  // PI Lab ignores a notebook page's beforeunload; leave Playwright's dialog alone.
  if (!appClosed) (await app.firstWindow()).on("dialog", () => undefined)
  if (!appClosed) await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

/** Open the Analysis notebook in a tab and return the stand-in server's pid. */
async function openNotebookTab(): Promise<number> {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  await openAnalysisExperiment(window, "run")
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
  // Stopped with SIGTERM first, so the server could shut down by itself.
  expect(await readFile(markerPath, "utf8")).toContain(`stop:${pid}`)
})

test("reloading the window stops its notebook servers (stand-in uvx)", async () => {
  const pid = await openNotebookTab()
  const window = await app.firstWindow()
  window.on("dialog", () => undefined)
  await window.reload()
  await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false)
})

test("an HTML report in the same window cannot reach a notebook server; the notebook tab can (stand-in uvx)", async () => {
  await openNotebookTab()
  const window = await app.firstWindow()
  const notebookUrl = await window.getByTestId("notebook-frame").getAttribute("src")
  const origin = new URL(String(notebookUrl)).origin
  const notebook = window.frames().find((each) => each.url().startsWith(origin))
  expect(await notebook?.evaluate(async () => (await fetch("/api/contents")).ok)).toBe(true)

  await openAnalysisExperiment(window, "run")
  await window
    .locator('[data-testid="analysis-file"][data-rel-path="results/run/probe.html"]')
    .click()
  await expect(
    window.frameLocator('[data-testid="analysis-preview-html"]').locator("#ready"),
  ).toBeVisible()
  const report = window.frames().find((each) => each.url().startsWith("pi-lab-report:"))
  const probe = (url: string) =>
    report?.evaluate(
      (target) => (window as unknown as { probe: (u: string) => Promise<string> }).probe(target),
      url,
    )
  expect(await probe(`${origin}/api/contents`)).toBe("blocked")
})

test("with the right panel open on Sessions and the research diary, the preview's Open notebook button is not covered", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1200, 800))
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  await openAnalysisExperiment(window, "run")
  await window
    .locator('[data-testid="analysis-file"][data-rel-path="results/run/analysis.ipynb"]')
    .click()
  // The right panel starts open on the Sessions tab; the diary button shows the Diary tab.
  const diaryToggle = window.getByTestId("analysis-research-diary")
  await expect(diaryToggle).toHaveAttribute("aria-pressed", "false")
  await diaryToggle.click()
  await expect(diaryToggle).toHaveAttribute("aria-pressed", "true")
  await expect(window.getByTestId("science-sessions")).toHaveAttribute("data-collapsed", "false")
  const button = window.getByTestId("analysis-open-notebook")
  await expect(button).toBeVisible()
  const uncovered = await button.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const points = [
      [box.left + 2, box.top + box.height / 2],
      [box.left + box.width / 2, box.top + box.height / 2],
      [box.right - 2, box.top + box.height / 2],
    ]
    return points.every(([x, y]) => element.contains(document.elementFromPoint(x ?? 0, y ?? 0)))
  })
  expect(uncovered).toBe(true)
})

test("Open notebook runs a Jupyter server in a tab, and closing the tab stops it (stand-in uvx)", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  await expect(window.getByTestId("science-analysis")).toBeVisible({ timeout: 30_000 })

  await openAnalysisExperiment(window, "run")
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

  // Closing asks first; Cancel keeps the tab and its server.
  await tab.getByTestId("central-tab-close").click()
  const prompt = window.getByTestId("close-session-prompt")
  await expect(prompt).toContainText(
    "Save the notebook in its tab first; closing stops its server.",
  )
  await prompt.getByRole("button", { name: "Cancel" }).click()
  await expect(tab).toHaveCount(1)
  expect(alive(pid)).toBe(true)

  // Collapsing the Sessions panel keeps the page (with its unsaved state) and its server.
  const notebookFrame = () =>
    window.frames().find((each) => each.url().startsWith("http://127.0.0.1:427"))
  await notebookFrame()?.evaluate(() => {
    ;(window as unknown as { unsaved: string }).unsaved = "edit"
  })
  await window.getByTestId("right-sidebar-collapse").click()
  await window.getByTestId("science-sessions-expand").click()
  await expect(page.locator("#notebook-stand-in")).toBeVisible()
  // Another tab of the panel hides the page without reloading it.
  await window.getByTestId("panel-tab-diary").click()
  await window.getByTestId("panel-tab-sessions").click()
  await expect(page.locator("#notebook-stand-in")).toBeVisible()
  expect(
    await notebookFrame()?.evaluate(() => (window as unknown as { unsaved?: string }).unsaved),
  ).toBe("edit")
  expect(alive(pid)).toBe(true)
  expect(await readFile(markerPath, "utf8")).not.toContain(`stop:${pid}`)

  await tab.getByTestId("central-tab-close").click()
  await prompt.getByTestId("close-session-confirm").click()
  await expect(tab).toHaveCount(0)
  await expect.poll(async () => readFile(markerPath, "utf8")).toContain(`stop:${pid}`)
  await expect.poll(() => alive(pid)).toBe(false)
})
