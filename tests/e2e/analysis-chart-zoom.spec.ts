import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { openAnalysisExperiment } from "./fixtures/analysis"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from "./fixtures/playwright"

/**
 * Chart zoom in Analysis through the real app: drag across a chart to zoom
 * into an x range, the +, − and reset buttons, and double-click to reset. It
 * covers a 1-D `.npy` series (MetricChart) and a `step,loss` CSV (the chart
 * builder's line chart). Every project file is synthetic and lives in a temp
 * data folder; nothing touches the user's app data.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const DESKTOP = join(ROOT, "apps", "desktop")
const MAIN = join(DESKTOP, "out", "main", "index.js")
const ELECTRON = createRequire(join(DESKTOP, "package.json"))("electron") as string
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional packaged app verification.
const packagedBinary = process.env.PI_LAB_PACKAGED_BINARY
const execFileAsync = promisify(execFile)

/** Points in each synthetic series: x runs 0..200. */
const POINTS = 201
/** Must match PLOT_MARGIN.right and Y_AXIS_WIDTH in MetricChart.tsx. */
const PLOT_LEFT = 60
const PLOT_RIGHT_MARGIN = 28

/** Wrap little-endian float64 values in a version 1 NumPy file. */
function numpySeries(values: number[]): Buffer {
  let header = `{'descr': '<f8', 'fortran_order': False, 'shape': (${values.length},), }`
  header += `${" ".repeat((64 - ((10 + header.length + 1) % 64)) % 64)}\n`
  const prefix = Buffer.alloc(10)
  prefix[0] = 0x93
  prefix.write("NUMPY", 1, "ascii")
  prefix[6] = 1
  prefix.writeUInt16LE(header.length, 8)
  const data = Buffer.alloc(values.length * 8)
  values.forEach((value, index) => {
    data.writeDoubleLE(value, index * 8)
  })
  return Buffer.concat([prefix, Buffer.from(header, "ascii"), data])
}

let app: ElectronApplication | undefined
let dataDir: string
let repo: string

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-analysis-chart-zoom-"))
  repo = join(dataDir, "repo")
  await execFileAsync("git", ["init", "-b", "main", repo])
  await execFileAsync("git", ["-C", repo, "config", "user.email", "test@pi-lab.local"])
  await execFileAsync("git", ["-C", repo, "config", "user.name", "PI Lab Test"])
  const run = join(repo, "results", "run-a")
  await mkdir(run, { recursive: true })
  const losses = Array.from({ length: POINTS }, (_, i) => 1 / (i + 1))
  await writeFile(join(run, "losses.npy"), numpySeries(losses))
  const rows = losses.map((loss, step) => `${step},${loss}`)
  await writeFile(join(run, "metrics.csv"), `step,loss\n${rows.join("\n")}\n`)
  await writeFile(join(repo, "README.md"), "# fixture\n")
  await execFileAsync("git", ["-C", repo, "add", "."])
  await execFileAsync("git", ["-C", repo, "commit", "-m", "fixture"])
})

test.afterEach(async () => {
  await closeApp()
  await rm(dataDir, { recursive: true, force: true })
})

/** Launch the app on the temp project and open its Analysis tab on `run-a`. */
async function openAnalysis(): Promise<Page> {
  await launch()
  const window = await (app as ElectronApplication).firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  await openAnalysisExperiment(window, "run-a")
  return window
}

/** Launch the real app on the temp project. */
async function launch(): Promise<void> {
  app = await electron.launch({
    executablePath: packagedBinary ?? ELECTRON,
    args: packagedBinary ? [] : [MAIN],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      // Not the folder that holds the project: a packaged Alpha empties its
      // data folder on a new build (`db/alphaBuildReset.ts`).
      PI_LAB_DATA_DIR: join(dataDir, "data"),
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: repo,
    },
  })
}

/** Close the app and its windows. */
async function closeApp(): Promise<void> {
  if (!app) return
  const child = app.process()
  const forceExit = setTimeout(() => child.kill("SIGKILL"), 5_000)
  await app
    .evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy()
    })
    .catch(() => undefined)
  await app.close().catch(() => child.kill("SIGKILL"))
  clearTimeout(forceExit)
  app = undefined
}

/** Click a listed file of `run-a` by its name. */
async function selectFile(window: Page, name: string): Promise<void> {
  const file = window.locator(
    `[data-testid="analysis-file"][data-rel-path="results/run-a/${name}"]`,
  )
  await expect(file).toBeVisible({ timeout: 30_000 })
  await file.click()
}

/** The numbers on the chart's x axis ticks. */
async function xTicks(chart: Locator): Promise<number[]> {
  const texts = await chart
    .locator(".recharts-xAxis .recharts-cartesian-axis-tick-value")
    .allTextContents()
  return texts.map(Number)
}

/** Wait until the x ticks lie inside [min, max] and the largest is at most `max`. */
async function expectTicksWithin(chart: Locator, min: number, max: number): Promise<void> {
  await expect
    .poll(async () => {
      const ticks = await xTicks(chart)
      return ticks.length > 0 && Math.min(...ticks) >= min && Math.max(...ticks) <= max
    })
    .toBe(true)
}

/** Wait until the x axis shows the whole series again (last tick 200). */
async function expectFullRange(chart: Locator): Promise<void> {
  await expect.poll(async () => Math.max(...(await xTicks(chart)))).toBe(POINTS - 1)
}

/** Drag across the plot area from x value `from` to x value `to` (full range 0..200). */
async function dragOver(window: Page, chart: Locator, from: number, to: number): Promise<void> {
  const box = await chart.locator(".recharts-wrapper").boundingBox()
  if (!box) throw new Error("Expected the chart to have a size")
  const plotWidth = box.width - PLOT_LEFT - PLOT_RIGHT_MARGIN
  const pixel = (x: number): number => box.x + PLOT_LEFT + (x / (POINTS - 1)) * plotWidth
  const y = box.y + box.height / 2
  await window.mouse.move(pixel(from), y)
  await window.mouse.down()
  await window.mouse.move(pixel(to), y, { steps: 8 })
  await window.mouse.up()
}

/** The zoom checks shared by both chart kinds. */
async function checkZoom(window: Page, chart: Locator): Promise<void> {
  await expectFullRange(chart)
  await expect(chart.getByTestId("analysis-chart-zoom-reset")).toBeDisabled()

  // Drag over x 50..100: the axis shows only that range.
  await dragOver(window, chart, 50, 100)
  await expectTicksWithin(chart, 48, 102)
  await expect(chart.getByTestId("analysis-chart-zoom-reset")).toBeEnabled()

  // Reset shows everything again.
  await chart.getByTestId("analysis-chart-zoom-reset").click()
  await expectFullRange(chart)

  // + shows the middle half (50..150); − goes back to the full range.
  await chart.getByTestId("analysis-chart-zoom-in").click()
  await expectTicksWithin(chart, 50, 150)
  await chart.getByTestId("analysis-chart-zoom-in").click()
  await expectTicksWithin(chart, 75, 125)
  await chart.getByTestId("analysis-chart-zoom-out").click()
  await expectTicksWithin(chart, 50, 150)
  await chart.getByTestId("analysis-chart-zoom-out").click()
  await expectFullRange(chart)

  // Double-click resets a zoom.
  await chart.getByTestId("analysis-chart-zoom-in").click()
  await expectTicksWithin(chart, 50, 150)
  await chart.locator(".recharts-wrapper").dblclick()
  await expectFullRange(chart)
}

test("a .npy series chart zooms by drag, +, − and reset", async () => {
  test.setTimeout(120_000)
  const window = await openAnalysis()
  await selectFile(window, "losses.npy")
  const chart = window.getByTestId("analysis-preview-chart")
  await expect(chart).toBeVisible({ timeout: 30_000 })
  await checkZoom(window, chart)
})

test("a step,loss CSV line chart zooms by drag, +, − and reset", async () => {
  test.setTimeout(120_000)
  const window = await openAnalysis()
  await selectFile(window, "metrics.csv")
  const chart = window.getByTestId("analysis-plot")
  await expect(chart).toBeVisible({ timeout: 30_000 })
  await checkZoom(window, chart)
})
