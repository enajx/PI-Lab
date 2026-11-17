import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { openAnalysisExperiment, openAnalysisFolder } from "./fixtures/analysis"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "./fixtures/playwright"

/**
 * Analysis data readers through the real app: object `.npy` (pickled payload),
 * HDF5, Parquet, the Large file prompt and the chart tooltip. Every project file
 * lives in a temp data folder; nothing touches the user's app data.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const DESKTOP = join(ROOT, "apps", "desktop")
const MAIN = join(DESKTOP, "out", "main", "index.js")
const ELECTRON = createRequire(join(DESKTOP, "package.json"))("electron") as string
const FIXTURES = join(DESKTOP, "src", "main", "trpc", "science", "analysis", "__fixtures__")
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional packaged app verification.
const packagedBinary = process.env.PI_LAB_PACKAGED_BINARY
const execFileAsync = promisify(execFile)

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

/** Over the 32 MiB pickle limit, so Analysis asks before reading. */
const LARGE_BYTES = 33 * 1024 * 1024

/** A protocol 4 pickle of one bytes object, `size` bytes long in all. */
function largePickle(size: number): Buffer {
  const length = size - 12
  const head = Buffer.alloc(11)
  head[0] = 0x80
  head[1] = 4
  head[2] = 0x8e // BINBYTES8
  head.writeBigUInt64LE(BigInt(length), 3)
  return Buffer.concat([head, Buffer.alloc(length), Buffer.from([0x2e])])
}

let app: ElectronApplication | undefined
let dataDir: string
let repo: string

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-analysis-readers-"))
  repo = join(dataDir, "repo")
  await execFileAsync("git", ["init", "-b", "main", repo])
  await execFileAsync("git", ["-C", repo, "config", "user.email", "test@pi-lab.local"])
  await execFileAsync("git", ["-C", repo, "config", "user.name", "PI Lab Test"])
  const run = join(repo, "results", "run-a")
  await mkdir(run, { recursive: true })
  await writeFile(
    join(run, "training_losses.npy"),
    numpySeries(Array.from({ length: 50 }, (_, i) => 1 / (i + 1))),
  )
  await copyFile(join(FIXTURES, "pickle", "object-all-none.npy"), join(run, "checksums.npy"))
  await copyFile(join(FIXTURES, "pickle", "p2-frame.pkl"), join(run, "frame.pkl"))
  await copyFile(join(FIXTURES, "data", "runs.h5"), join(run, "runs.h5"))
  await copyFile(join(FIXTURES, "data", "frame-zstd.parquet"), join(run, "frame.parquet"))
  await writeFile(join(run, "big.pkl"), largePickle(LARGE_BYTES))
  // The same long-format table twice under one file name (synthetic).
  await copyFile(join(FIXTURES, "data", "long.csv"), join(run, "options.csv"))
  await mkdir(join(run, "other"), { recursive: true })
  await copyFile(join(FIXTURES, "data", "long.csv"), join(run, "other", "options.csv"))
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
      // Export CSV saves here instead of asking with the native save dialog.
      PI_LAB_TEST_SAVE_FILE: join(dataDir, "export.csv"),
    },
  })
}

/** Close the app as afterEach does (used to restart it). */
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

test("hovering the line chart shows the x value and each series value", async () => {
  test.setTimeout(120_000)
  const window = await openAnalysis()
  await selectFile(window, "training_losses.npy")
  const chart = window.getByTestId("analysis-preview-chart")
  await expect(chart).toBeVisible()
  const plot = chart.locator(".recharts-wrapper")
  const box = await plot.boundingBox()
  if (!box) throw new Error("Expected the chart to have a size")
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  // The x line names the axis, and values have about 4 significant digits.
  await expect(chart.getByTestId("analysis-chart-tooltip-label")).toHaveText(/^index \d+$/)
  await expect(chart.getByTestId("analysis-chart-tooltip-item")).toHaveText(
    /^training_losses: 0\.\d{1,5}$/,
  )
  await expect(chart.getByTestId("analysis-chart-tooltip-item")).toHaveCount(1)
})

test("an object .npy of None says what it stores, and a pandas pickle is a table", async () => {
  test.setTimeout(120_000)
  const window = await openAnalysis()
  await selectFile(window, "checksums.npy")
  await expect(window.getByTestId("analysis-preview-metadata")).toContainText(
    "Stores Python objects; all 200 values are None",
  )
  await selectFile(window, "frame.pkl")
  // A metric log (step, loss): it opens as a chart; Table shows the rows.
  await expect(window.getByTestId("analysis-plot")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("analysis-view-table").click()
  const table = window.getByTestId("analysis-preview-table")
  await expect(table.locator("thead th")).toHaveText(["index", "step", "loss", "name", "when"])
  await expect(table.locator("tbody tr").first().locator("td")).toHaveText([
    "0",
    "0",
    "0.5",
    "a",
    "2024-01-01",
  ])
})

test("an HDF5 file lists its datasets and previews the chosen one", async () => {
  test.setTimeout(120_000)
  const window = await openAnalysis()
  await selectFile(window, "runs.h5")
  const select = window.getByTestId("analysis-preview-dataset")
  await expect(select).toBeVisible({ timeout: 30_000 })
  await expect(select.locator("option")).toHaveCount(6)
  await select.selectOption("/loss")
  await expect(window.getByTestId("analysis-preview-chart")).toBeVisible()
  await expect(window.getByTestId("analysis-chart-legend")).toContainText("loss")
  await select.selectOption("/eval/table")
  await expect(window.getByTestId("analysis-plot-legend")).toHaveText("acc")
  await window.getByTestId("analysis-view-table").click()
  const table = window.getByTestId("analysis-preview-table")
  await expect(table.locator("thead th")).toHaveText(["step", "acc"])
  await expect(table.locator("tbody tr")).toHaveCount(3)
})

test("a Parquet file previews its first rows", async () => {
  test.setTimeout(120_000)
  const window = await openAnalysis()
  await selectFile(window, "frame.parquet")
  await expect(window.getByTestId("analysis-plot")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("analysis-view-table").click()
  const table = window.getByTestId("analysis-preview-table")
  await expect(table.locator("thead th")).toHaveText(["step", "loss", "name", "when"])
  await expect(table.locator("tbody tr").last().locator("td")).toHaveText([
    "3",
    "0.25",
    "d",
    "2024-01-04",
  ])
  await expect(window.getByTestId("analysis-preview-rowcount")).toHaveText("4 rows")
})

test("a large file asks before loading and loads on Load", async () => {
  test.setTimeout(120_000)
  const window = await openAnalysis()
  await selectFile(window, "big.pkl")
  const prompt = window.getByTestId("analysis-preview-large")
  await expect(prompt).toHaveText(/Large file \(34\.6 MB\), loading may be slow/)
  await window.getByTestId("analysis-preview-load").click()
  await expect(window.getByTestId("analysis-preview-json")).toContainText("b'", {
    timeout: 30_000,
  })
})

test("a long-format table opens as a table; the chart builder plots it and the choice is kept for that file name", async () => {
  test.setTimeout(180_000)
  let window = await openAnalysis()
  await selectFile(window, "options.csv")
  await expect(window.getByTestId("analysis-preview-table")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("analysis-view-table")).toHaveAttribute("aria-selected", "true")

  // Chart: mean probability per question.
  await window.getByTestId("analysis-view-chart").click()
  const plot = window.getByTestId("analysis-plot")
  await expect(plot).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("analysis-plot-legend")).toHaveText("probability")
  await expect(plot.locator(".recharts-xAxis")).toContainText("question")

  // Split by option, with a min-to-max band, as bars.
  await window.getByTestId("analysis-chart-settings").click()
  await window.getByTestId("analysis-chart-split").selectOption("option")
  await expect(window.getByTestId("analysis-plot-legend")).toHaveText(
    /option=a.*option=b.*option=c/,
  )
  await window.getByTestId("analysis-chart-band").selectOption("minmax")
  await expect(plot.locator(".recharts-area")).toHaveCount(3)
  await window.getByTestId("analysis-chart-type").selectOption("bar")
  await expect(plot.locator(".recharts-bar-rectangle").first()).toBeVisible()
  // Error bars are drawn (zero length here: the fixture's values do not vary within a group).
  await expect(plot.locator(".recharts-errorBar")).not.toHaveCount(0)
  await window.keyboard.press("Escape")
  await expect(window.getByTestId("analysis-chart-settings-panel")).toHaveCount(0)

  // Another options.csv in the project opens with the same chart, also after a restart.
  await openAnalysisFolder(window, "other")
  await selectFile(window, "other/options.csv")
  await expect(window.getByTestId("analysis-plot-legend")).toHaveText(/option=a.*option=c/)
  await closeApp()
  window = await openAnalysis()
  await openAnalysisFolder(window, "other")
  await selectFile(window, "other/options.csv")
  await expect(window.getByTestId("analysis-view-chart")).toHaveAttribute("aria-selected", "true")
  await expect(
    window.getByTestId("analysis-plot").locator(".recharts-bar-rectangle").first(),
  ).toBeVisible({
    timeout: 30_000,
  })

  // Reset to default stays in Chart view with the automatic settings.
  await window.getByTestId("analysis-chart-settings").click()
  await window.getByTestId("analysis-chart-reset").click()
  await expect(window.getByTestId("analysis-view-chart")).toHaveAttribute("aria-selected", "true")
  await expect(window.getByTestId("analysis-plot-legend")).toHaveText("probability")
  await expect(window.getByTestId("analysis-plot").locator(".recharts-line")).toHaveCount(1)
})

test("a file over 1 GB warns and shows its first rows; Load anyway reads it", async () => {
  test.setTimeout(120_000)
  // A sparse file: the first rows, then zeros up to just over 1 GiB.
  const huge = join(repo, "results", "run-a", "huge.csv")
  await writeFile(huge, "step,loss\n0,1.0\n1,0.5\n2,0.25\n")
  await truncate(huge, 1024 * 1024 * 1024 + 1)
  const window = await openAnalysis()
  await selectFile(window, "huge.csv")
  await expect(window.getByTestId("analysis-preview-large")).toContainText(
    "Loading it may be slow or fail",
  )
  const partial = window.getByTestId("analysis-preview-partial")
  await expect(partial.locator("tbody tr")).toHaveCount(3)
  await window.getByTestId("analysis-preview-load").click()
  await expect(window.getByTestId("analysis-table-chart")).toBeVisible({ timeout: 60_000 })
})

test("a load that fails says why and falls back to the view without loading", async () => {
  test.setTimeout(120_000)
  // A sparse pickle over 2 GiB: Node cannot read it whole, so Load anyway fails.
  const huge = join(repo, "results", "run-a", "huge.pkl")
  await writeFile(huge, Buffer.from([0x80, 4]))
  await truncate(huge, 2 * 1024 * 1024 * 1024 + 1)
  const window = await openAnalysis()
  await selectFile(window, "huge.pkl")
  await expect(window.getByTestId("analysis-preview-large")).toContainText(
    "Loading it may be slow or fail",
  )
  await window.getByTestId("analysis-preview-load").click()
  await expect(window.getByTestId("analysis-preview-load-failed")).toBeVisible({ timeout: 60_000 })
  await expect(window.getByTestId("analysis-preview-load-failed")).toContainText("2 GiB")
  await expect(window.getByTestId("analysis-preview-large")).toBeVisible()
  // The app keeps working: another file still previews.
  await selectFile(window, "options.csv")
  await expect(window.getByTestId("analysis-preview-table")).toBeVisible({ timeout: 30_000 })
})

test("table settings filter and sort, Aggregate groups rows, the chart plots the result, and Export CSV saves it", async () => {
  test.setTimeout(180_000)
  let window = await openAnalysis()
  await selectFile(window, "options.csv")
  await expect(window.getByTestId("analysis-preview-table")).toBeVisible({ timeout: 30_000 })

  // Filter option = c, sorted by probability descending.
  await window.getByTestId("analysis-table-settings").click()
  await window.getByTestId("analysis-table-add-filter").click()
  const filter = window.getByTestId("analysis-table-filter")
  await filter.getByTestId("analysis-table-filter-column").selectOption("option")
  await filter.getByTestId("analysis-table-filter-value").fill("c")
  await expect(window.getByTestId("analysis-preview-rowcount")).toHaveText("36 rows")
  await window.keyboard.press("Escape")
  await window.getByTestId("analysis-table-header").filter({ hasText: "probability" }).click()
  await window.getByTestId("analysis-table-header").filter({ hasText: "probability" }).click()
  const firstRow = window.getByTestId("analysis-table-row").first()
  await expect(firstRow).toContainText("0.26")
  await expect(window.getByTestId("analysis-table-ops")).toHaveText(
    /1 filter · Sorted by probability ↓/,
  )

  // Group by question with the mean probability: 6 rows, which the chart plots.
  await window.getByTestId("analysis-table-aggregate").click()
  await window.getByTestId("analysis-aggregate-kind").selectOption("groupBy")
  await expect(window.getByTestId("analysis-preview-rowcount")).toHaveText("6 rows")
  await expect(window.getByTestId("analysis-table-header")).toHaveText([
    "question",
    "probability (mean)",
  ])
  await window.keyboard.press("Escape")
  await window.getByTestId("analysis-view-chart").click()
  await expect(window.getByTestId("analysis-plot-legend")).toHaveText("probability (mean)")

  // Export CSV writes the shown result.
  await window.getByTestId("analysis-table-export").click()
  await expect(window.getByTestId("analysis-table-exported")).toContainText("Saved 6 rows")
  const exported = await readFile(join(dataDir, "export.csv"), "utf8")
  expect(exported.split("\n")[0]).toBe("question,probability (mean)")
  expect(exported.split("\n")[6]).toBe("6,0.26")

  // Another options.csv opens with the same operations, also after a restart.
  await closeApp()
  window = await openAnalysis()
  await openAnalysisFolder(window, "other")
  await selectFile(window, "other/options.csv")
  await expect(window.getByTestId("analysis-plot-legend")).toHaveText("probability (mean)", {
    timeout: 30_000,
  })
  await window.getByTestId("analysis-table-clear-ops").click()
  await window.getByTestId("analysis-view-table").click()
  await expect(window.getByTestId("analysis-preview-rowcount")).toHaveText("108 rows")
})

test("the table scrolls to its last row, and text size and Fit are kept after a restart", async () => {
  test.setTimeout(180_000)
  const lines = ["id,group,value,note"]
  for (let i = 0; i < 3000; i++) lines.push(`${i},g${i % 4},${(i * 0.37) % 11},row number ${i}`)
  await writeFile(join(repo, "results", "run-a", "many.csv"), `${lines.join("\n")}\n`)
  let window = await openAnalysis()
  await selectFile(window, "many.csv")
  // An increasing id and a number column read as a metric log, so it opens as a chart.
  await window.getByTestId("analysis-view-table").click()
  await expect(window.getByTestId("analysis-preview-rowcount")).toHaveText("3,000 rows", {
    timeout: 30_000,
  })
  const scroll = window.getByTestId("analysis-table-scroll")
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect(window.locator('[data-testid="analysis-table-row"][data-row="2999"]')).toContainText(
    "row number 2999",
  )

  await window.getByTestId("analysis-table-zoom-in").click()
  await expect(window.getByTestId("analysis-table-zoom")).toHaveText("110%")
  await window.getByTestId("analysis-table-zoom-fit").click()
  const zoom = await window.getByTestId("analysis-table-zoom").textContent()
  const fits = await scroll.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
  expect(fits).toBe(true)
  await closeApp()
  window = await openAnalysis()
  await selectFile(window, "many.csv")
  await expect(window.getByTestId("analysis-table-zoom")).toHaveText(zoom ?? "")
})
