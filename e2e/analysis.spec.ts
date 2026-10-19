import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { createRequire } from "node:module"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

/**
 * Whole-app E2E: launch the real Electron build, open a
 * temp git repo as a project via the `?openProject` seam (no native dialog),
 * navigate to the Analysis science tab, select the CSV the repo contains, and
 * prove the preview table renders end to end.
 *
 * MUST run under Node (not Bun) — Playwright's `_electron` launcher hangs under
 * Bun; the repo `e2e` script runs Playwright's CLI through node.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const MARIMO_FIXTURE = join(HERE, "fixtures", "marimo-server.cjs")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

const execFileAsync = promisify(execFile)

const CSV_REL_PATH = "data/metrics.csv"
// A non-metric CSV (second column non-numeric) so the preview renders as a TABLE.
// A two-numeric-column series like `epoch,loss` is now auto-detected as a metric
// chart (see discover.ts detectScalarChart), which renders a chart, not a table.
const CSV_BODY = "epoch,label\n0,start\n1,middle\n2,end\n"

let app: ElectronApplication
let dataDir: string
let repoDir: string
let markerPath: string
let reportNetworkServer: Server
let reportNetworkUrl: string

/** Initialize a throwaway git repo with one commit and a CSV on `main`. */
async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", dir])
  const run = (args: string[]) => execFileAsync("git", ["-C", dir, ...args])
  await run(["config", "user.email", "test@pi-lab.local"])
  await run(["config", "user.name", "PI Lab Test"])
  await writeFile(join(dir, "README.md"), "# fixture\n")

  // A data file the Analysis tab should discover and preview as a table.
  await mkdir(join(dir, "data"), { recursive: true })
  await writeFile(join(dir, CSV_REL_PATH), CSV_BODY)
  await writeFile(join(dir, "analysis.py"), "print('source, not a result artifact')\n")
  await mkdir(join(dir, "reports"), { recursive: true })
  await writeFile(
    join(dir, "reports", "interactive.html"),
    "<!doctype html><button id='counter'>0</button><button id='navigate'>Navigate top</button><div id='capabilities'></div><div id='network'></div><div id='popup'></div><script src='./interactive.js'></script>",
  )
  await writeFile(
    join(dir, "reports", "interactive.js"),
    `counter.onclick = () => counter.textContent = String(Number(counter.textContent) + 1)
capabilities.textContent = [
  "require:" + typeof window.require,
  "process:" + typeof window.process,
  "piLab:" + typeof window.piLab,
  "trpc:" + typeof window.electronTRPC,
].join("|")
fetch(${JSON.stringify(reportNetworkUrl)}).then((response) => response.text()).then((text) => network.textContent = text)
navigate.onclick = () => {
  popup.textContent = window.open("https://example.com/") === null ? "popup-blocked" : "popup-opened"
  window.top.location.href = "https://example.com/"
}
`,
  )
  await writeFile(join(dir, "reports", "live.py"), "import marimo\napp = marimo.App()\n")

  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-analysis-"))
  markerPath = join(dataDir, "marimo-lifecycle.log")
  reportNetworkServer = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/plain",
      "access-control-allow-origin": "*",
    })
    response.end("network-ok")
  })
  await new Promise<void>((resolveListen) =>
    reportNetworkServer.listen(0, "127.0.0.1", resolveListen),
  )
  const address = reportNetworkServer.address() as AddressInfo
  reportNetworkUrl = `http://127.0.0.1:${address.port}/marker`
  repoDir = join(dataDir, "repo")
  await initRepo(repoDir)

  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      // Open the temp repo as a project on load (renderer query seam).
      PI_LAB_TEST_OPEN_PROJECT: repoDir,
      PI_LAB_TEST_MARIMO_FIXTURE: MARIMO_FIXTURE,
      PI_LAB_TEST_MARIMO_MARKER: markerPath,
    },
  })
})

test.afterEach(async () => {
  await app?.close()
  await new Promise<void>((resolveClose) => reportNetworkServer?.close(() => resolveClose()))
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

async function lifecycleLog(): Promise<string> {
  return readFile(markerPath, "utf8").catch(() => "")
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("analysis tab previews a CSV discovered in the opened project", async () => {
  const window = await app.firstWindow()

  // Boot gate.
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  // The `?openProject` seam opens the repo; it shows in the sidebar.
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })

  // Navigate to the Analysis science tab via the sidebar nav.
  const analysisNav = window.locator(
    '[data-testid="science-nav-item"][data-science-tab="analysis"]',
  )
  await expect(analysisNav).toBeVisible({ timeout: 30_000 })
  await analysisNav.click()

  // The tab renders, defaulting to the just-opened project.
  await expect(window.getByTestId("science-analysis")).toBeVisible({ timeout: 30_000 })

  // The repo's CSV appears in the file list.
  const fileRow = window.locator(`[data-testid="analysis-file"][data-rel-path="${CSV_REL_PATH}"]`)
  await expect(fileRow).toBeVisible({ timeout: 30_000 })
  await expect(
    window.locator('[data-testid="analysis-file"][data-rel-path="analysis.py"]'),
  ).toHaveCount(0)

  // Selecting it renders the preview table.
  await fileRow.click()
  const table = window.getByTestId("analysis-preview-table")
  await expect(table).toBeVisible({ timeout: 30_000 })
  // The header row reflects the CSV's columns.
  await expect(table.locator("thead th")).toHaveCount(2)
  await expect(table.locator("thead th").first()).toHaveText("epoch")
})

test("interactive HTML is sandboxed while scripts, relative assets, and network fetch work", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()

  await window
    .locator('[data-testid="analysis-file"][data-rel-path="reports/interactive.html"]')
    .click()
  const report = window.frameLocator('[data-testid="analysis-preview-html"]')
  await expect(report.locator("#counter")).toHaveText("0", { timeout: 30_000 })
  await report.locator("#counter").click()
  await expect(report.locator("#counter")).toHaveText("1")
  await expect(report.locator("#network")).toHaveText("network-ok")
  await expect(report.locator("#capabilities")).toHaveText(
    "require:undefined|process:undefined|piLab:undefined|trpc:undefined",
  )

  const hostUrl = window.url()
  await report.locator("#navigate").click()
  await expect(report.locator("#popup")).toHaveText("popup-blocked")
  expect(window.url()).toBe(hostUrl)
  await expect(window.getByTestId("science-analysis")).toBeVisible()
})

test("marimo starts interactively, stops on artifact switch, and is reaped on app exit", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()

  const marimoRow = window.locator('[data-testid="analysis-file"][data-rel-path="reports/live.py"]')
  await marimoRow.click()
  const notebook = window.frameLocator('[data-testid="analysis-preview-marimo"]')
  await expect(notebook.locator("#marimo-counter")).toHaveText("0", { timeout: 30_000 })
  await notebook.locator("#marimo-counter").click()
  await expect(notebook.locator("#marimo-counter")).toHaveText("1")
  await expect.poll(lifecycleLog).toMatch(/start:\d+/)

  await window.locator(`[data-testid="analysis-file"][data-rel-path="${CSV_REL_PATH}"]`).click()
  await expect(window.getByTestId("analysis-preview-table")).toBeVisible()
  await expect.poll(lifecycleLog).toMatch(/stop:\d+/)

  await marimoRow.click()
  await expect(
    window.frameLocator('[data-testid="analysis-preview-marimo"]').locator("#marimo-counter"),
  ).toBeVisible({ timeout: 30_000 })
  await expect.poll(lifecycleLog).toMatch(/(?:start:\d+\n.*){2}/s)
  const starts = (await lifecycleLog()).split("\n").filter((line) => line.startsWith("start:"))
  const finalPid = Number(starts.at(-1)?.split(":")[1])
  expect(pidIsAlive(finalPid)).toBe(true)

  await app.close()
  await expect.poll(() => pidIsAlive(finalPid)).toBe(false)
})
