import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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
  await writeFile(join(repo, "README.md"), "# fixture\n")
  await execFileAsync("git", ["-C", repo, "add", "."])
  await execFileAsync("git", ["-C", repo, "commit", "-m", "fixture"])
})

test.afterEach(async () => {
  if (app) {
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
  await rm(dataDir, { recursive: true, force: true })
})

/** Launch the app on the temp project and open its Analysis tab on `run-a`. */
async function openAnalysis(): Promise<Page> {
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
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  await openAnalysisExperiment(window, "run-a")
  return window
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
  const table = window.getByTestId("analysis-preview-table")
  await expect(table.locator("thead th")).toHaveText(["", "step", "loss", "name", "when"])
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
  const table = window.getByTestId("analysis-preview-table")
  await expect(table.locator("thead th")).toHaveText(["step", "acc"])
  await expect(table.locator("tbody tr")).toHaveCount(3)
})

test("a Parquet file previews its first rows", async () => {
  test.setTimeout(120_000)
  const window = await openAnalysis()
  await selectFile(window, "frame.parquet")
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
