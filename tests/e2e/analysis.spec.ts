import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { createRequire } from "node:module"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { openAnalysisExperiment, openAnalysisFolder, openAnalysisGroup } from "./fixtures/analysis"
import { onePagePdf } from "./fixtures/pdf"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from "./fixtures/playwright"

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
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional packaged app verification.
const packagedBinary = process.env.PI_LAB_PACKAGED_BINARY
const MARIMO_FIXTURE = join(HERE, "fixtures", "marimo-server.cjs")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

const execFileAsync = promisify(execFile)

/** A 1×1 transparent PNG (smallest valid PNG). */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
)

// Analysis lists the project's results folder (`results/` by default).
const CSV_REL_PATH = "results/data/metrics.csv"
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
  await mkdir(join(dir, "results", "data"), { recursive: true })
  await writeFile(join(dir, CSV_REL_PATH), CSV_BODY)
  await writeFile(join(dir, "results", "analysis.py"), "print('source, not a result artifact')\n")
  // Two experiments (one folder each) and a data file outside the results folder.
  await mkdir(join(dir, "results", "exp-a"), { recursive: true })
  await writeFile(join(dir, "results", "exp-a", "plot.png"), TINY_PNG)
  await mkdir(join(dir, "results", "exp-b"), { recursive: true })
  await writeFile(join(dir, "results", "exp-b", "log.txt"), "step 1 loss 0.5\n")
  await writeFile(join(dir, "outside.csv"), "a\n1\n")
  // The folder the test folder picker returns (PI_LAB_TEST_PICK_DIRECTORY).
  await mkdir(join(dir, "outputs", "exp-c"), { recursive: true })
  await writeFile(join(dir, "outputs", "exp-c", "notes.txt"), "notes\n")
  await mkdir(join(dir, "results", "reports"), { recursive: true })
  await writeFile(
    join(dir, "results", "reports", "interactive.html"),
    "<!doctype html><button id='counter'>0</button><button id='navigate'>Navigate top</button><div id='capabilities'></div><div id='network'></div><div id='popup'></div><script src='./interactive.js'></script>",
  )
  await writeFile(
    join(dir, "results", "reports", "interactive.js"),
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
  await writeFile(join(dir, "results", "reports", "live.py"), "import marimo\napp = marimo.App()\n")

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
  app = await launchApp()
})

/** Launch the real app on the test's data folder (also used to restart it). */
function launchApp(): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: packagedBinary ?? ELECTRON_PATH,
    args: packagedBinary ? [] : [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_TEST_AGENT_ID: "test-echo",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      // Open the temp repo as a project on load (renderer query seam).
      PI_LAB_TEST_OPEN_PROJECT: repoDir,
      // User skills come from here, so the real home folder's skills stay out.
      PI_LAB_TEST_SKILLS_HOME: join(dataDir, "home"),
      PI_LAB_TEST_PICK_DIRECTORY: join(repoDir, "outputs"),
      PI_LAB_TEST_MARIMO_FIXTURE: MARIMO_FIXTURE,
      PI_LAB_TEST_MARIMO_MARKER: markerPath,
    },
  })
}

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

  // The repo's CSV appears in the file list, under its run (results/data/).
  await openAnalysisExperiment(window, "data")
  const fileRow = window.locator(`[data-testid="analysis-file"][data-rel-path="${CSV_REL_PATH}"]`)
  await expect(fileRow).toBeVisible({ timeout: 30_000 })
  await expect(
    window.locator('[data-testid="analysis-file"][data-rel-path="results/analysis.py"]'),
  ).toHaveCount(0)

  // Selecting it renders the preview table.
  await fileRow.click()
  const table = window.getByTestId("analysis-preview-table")
  await expect(table).toBeVisible({ timeout: 30_000 })
  // The header row reflects the CSV's columns.
  await expect(table.locator("thead th")).toHaveCount(2)
  await expect(table.locator("thead th").first()).toHaveText("epoch")
})

test("Analysis lists one collapsed row per experiment with no counts, the structure is set per project and survives a restart, and Change… picks another folder", async () => {
  // Runs of the gecko experiment (written before Analysis first lists the folder).
  for (const run of ["fl-shape_s0", "fl-shape_s1"]) {
    await mkdir(join(repoDir, "results", "gecko", run), { recursive: true })
    await writeFile(join(repoDir, "results", "gecko", run, "run.db"), "")
  }
  let window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  await expect(window.getByTestId("science-analysis")).toBeVisible({ timeout: 30_000 })

  // The results folder row sits above the search and shows the default folder.
  await expect(window.getByTestId("analysis-results-folder-path")).toHaveText("results/", {
    timeout: 30_000,
  })
  await expect(window.getByTestId("analysis-results-folder-reset")).toHaveCount(0)

  // Auto-detect: one row per experiment (gecko), and per run at the top of the
  // results folder. Rows start collapsed and show no file counts.
  const row = (experiment: string) =>
    window.locator(`[data-testid="analysis-experiment"][data-experiment="${experiment}"]`)
  const rows = () =>
    window
      .getByTestId("analysis-experiment")
      .evaluateAll((elements) =>
        elements.map((element) => [
          element.getAttribute("data-experiment"),
          element.getAttribute("aria-expanded"),
          element.textContent,
        ]),
      )
  await expect
    .poll(rows, { timeout: 30_000 })
    .toEqual(["data", "exp-a", "exp-b", "gecko", "reports"].map((name) => [name, "false", name]))
  await expect(window.getByTestId("analysis-file-count")).toHaveCount(0)
  await expect(window.getByTestId("analysis-file")).toHaveCount(0)
  // gecko's runs are folders inside it (collapsed), each with its files.
  await row("gecko").click()
  await expect(window.getByTestId("analysis-folder")).toHaveText(["fl-shape_s0", "fl-shape_s1"])
  await openAnalysisFolder(window, "fl-shape_s0")
  await expect(
    window.locator('[data-testid="analysis-file"][data-rel-path^="results/gecko/"]'),
  ).toHaveCount(1)
  await row("gecko").click()
  await openAnalysisExperiment(window, "exp-a")
  await expect(
    window.locator('[data-testid="analysis-file"][data-rel-path="results/exp-a/plot.png"]'),
  ).toBeVisible()
  await expect(
    window.locator('[data-testid="analysis-file"][data-rel-path="outside.csv"]'),
  ).toHaveCount(0)

  // The category filters still narrow the results files.
  await window.getByTestId("analysis-category-figure").click()
  await expect(window.getByTestId("analysis-experiment")).toHaveCount(1)
  await expect(window.getByTestId("analysis-file")).toHaveCount(1)
  await expect(window.getByTestId("analysis-file")).toHaveAttribute(
    "data-rel-path",
    "results/exp-a/plot.png",
  )
  await window.getByTestId("analysis-category-all").click()
  await window.screenshot({ path: resolve(".cache", "screens", "analysis-results.png") })

  // The select shows the project's effective choice, only the real options. The
  // project's own choice is saved in the YAML file in PI Lab's data folder, keyed
  // by the project path.
  let structure = window.getByTestId("analysis-structure")
  await expect(structure).toHaveValue("auto")
  expect(await structure.locator("option").allTextContents()).toEqual([
    "Auto-detect",
    "One folder per experiment",
    "Experiment / run folders",
    "Flat file list",
    "Custom pattern",
  ])
  await structure.selectOption("one-folder-per-experiment")
  await expect
    .poll(rows)
    .toEqual(
      ["data", "exp-a", "exp-b", "gecko", "reports"].map((name) => [
        name,
        name === "exp-a" ? "true" : "false",
        name,
      ]),
    )
  await openAnalysisExperiment(window, "gecko")
  await openAnalysisFolder(window, "fl-shape_s0")
  await expect(
    window.locator(
      '[data-testid="analysis-file"][data-rel-path="results/gecko/fl-shape_s0/run.db"]',
    ),
  ).toBeVisible()
  const yamlText = await readFile(join(dataDir, "experiments-structure.yaml"), "utf8")
  expect(yamlText).toContain("default: auto")
  expect(yamlText).toMatch(/projects:\n\s+.+repo: one-folder-per-experiment/)

  // The choice survives a restart of the app.
  await app.close()
  app = await launchApp()
  window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  structure = window.getByTestId("analysis-structure")
  await expect(structure).toHaveValue("one-folder-per-experiment", { timeout: 30_000 })
  await structure.selectOption("auto")
  await expect(structure).toHaveValue("auto")
  expect(await readFile(join(dataDir, "experiments-structure.yaml"), "utf8")).toMatch(
    /projects:\n\s+.+repo: auto/,
  )

  // Change… (test picker returns <project>/outputs) lists that folder for this project.
  await window.getByTestId("analysis-results-folder-change").click()
  await expect(window.getByTestId("analysis-results-folder-path")).toHaveText("outputs/")
  await expect.poll(() => rows().then((all) => all.map((entry) => entry[0]))).toEqual(["exp-c"])
  await expect(row("gecko")).toHaveCount(0)

  // Reset to default goes back to results/.
  await window.getByTestId("analysis-results-folder-reset").click()
  await expect(window.getByTestId("analysis-results-folder-path")).toHaveText("results/")
  await expect(row("gecko")).toBeVisible()
})

test("a category chip shows a row of format chips; picking PDF lists the PDFs, and a PDF previews in PDF.js", async () => {
  // A deep PDF figure (as in results/multiplexing/...) next to an SVG.
  const pdfDir = join(repoDir, "results", "multiplexing", "grid_7hf2hacr")
  await mkdir(pdfDir, { recursive: true })
  await writeFile(
    join(pdfDir, "gradient_magnitudes_7hf2hacr.pdf"),
    onePagePdf("Gradient magnitudes"),
  )
  await writeFile(join(pdfDir, "arch.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>")
  const pdfRel = "results/multiplexing/grid_7hf2hacr/gradient_magnitudes_7hf2hacr.pdf"
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  await expect(window.getByTestId("science-analysis")).toBeVisible({ timeout: 30_000 })

  // The chips: Text (for .txt) and no Plots, Images or Logs.
  const chips = window.getByTestId("analysis-category-filters")
  await expect(chips.getByRole("button")).toHaveText(
    ["All", "Data", "Figures", "Text", "Notebooks", "Reports"],
    { timeout: 30_000 },
  )
  // Under All, the second row has every format present.
  const formats = window.getByTestId("analysis-format-filters").getByRole("button")
  await expect(formats).toHaveText(["CSV", "PNG", "PDF", "SVG", "TXT", "PY", "HTML"])

  await window.getByTestId("analysis-category-figure").click()
  await expect(formats).toHaveText(["PNG", "PDF", "SVG", "JPG"])
  await expect(window.getByTestId("analysis-format-jpg")).toBeDisabled()
  await expect(window.getByText("All figures")).toHaveCount(0)
  const pdf = window.getByTestId("analysis-format-pdf")
  await pdf.click()
  await expect(pdf).toHaveAttribute("aria-pressed", "true")
  await expect(window.getByTestId("analysis-experiment")).toHaveCount(1)
  await openAnalysisExperiment(window, "multiplexing")
  await openAnalysisFolder(window, "grid_7hf2hacr")
  await expect(window.getByTestId("analysis-file")).toHaveCount(1)
  await window.screenshot({ path: resolve(".cache", "screens", "analysis-figures-pdf.png") })

  // Selecting the PDF renders its page in the bundled PDF.js viewer.
  await window.locator(`[data-testid="analysis-file"][data-rel-path="${pdfRel}"]`).click()
  const viewer = window.getByTestId("analysis-preview").getByTestId("pdf-viewer")
  await expect(viewer.locator(".page canvas").first()).toBeVisible({ timeout: 30_000 })
  await expect(viewer.locator(".textLayer")).toContainText("Gradient magnitudes")
  await expect(window.getByTestId("analysis-pdf-status")).toHaveText("Page 1 / 1")
  await window.screenshot({ path: resolve(".cache", "screens", "analysis-pdf-preview.png") })

  // Clicking PDF again shows all figures again.
  await pdf.click()
  await expect(pdf).toHaveAttribute("aria-pressed", "false")
  await expect(window.getByTestId("analysis-experiment")).toHaveCount(2)
})

test("a results folder laid out like the user's lists groups, then experiments, then their folder tree", async () => {
  // results/<group>/<experiment>/…, with output folders (plots/, runs/, animations/).
  const files = [
    "multiplexing/20260214_141942/best_loss_vs_n.csv",
    "multiplexing/20260214_141942/plots/best_loss_vs_n_log.png",
    "multiplexing/20260214_141942/runs/patterns_conditional_growth/n01_run0_141944/grid.png",
    "multiplexing/20260214_141942/runs/patterns_conditional_growth/n04_run0_141944/grid.png",
    "pattern_translation/easily-boss-grouse/training_curve.pdf",
    "pattern_translation/easily-boss-grouse/animations/growth.gif",
    "pattern_translation/FAIL-wholly-calm-badger/training_curve.pdf",
    "pattern_translation/fully-witty-marmot/grid.png",
    "pattern_translation/fully-witty-marmot/targets/t0.png",
    "patterns_conditional_growth/firmly-key-amoeba/grid.png",
  ]
  await rm(join(repoDir, "results"), { recursive: true })
  for (const file of files) {
    await mkdir(dirname(join(repoDir, "results", file)), { recursive: true })
    await writeFile(join(repoDir, "results", file), "x")
  }
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()

  // Top rows: the groups, collapsed; no experiment rows with deep paths.
  const groups = window.getByTestId("analysis-group")
  await expect(groups).toHaveText(
    ["multiplexing", "pattern_translation", "patterns_conditional_growth"],
    {
      timeout: 30_000,
    },
  )
  // No experiment rows at the top: they are inside their groups.
  await expect(window.getByTestId("analysis-experiment")).toHaveCount(0)
  // A group lists its experiments.
  await openAnalysisGroup(window, "pattern_translation")
  await expect(window.getByTestId("analysis-experiment")).toHaveText([
    "easily-boss-grouse",
    "FAIL-wholly-calm-badger",
    "fully-witty-marmot",
  ])
  // An experiment shows its tree: animations/ is a folder row before the files.
  await openAnalysisExperiment(window, "easily-boss-grouse")
  const grouse = window
    .locator('[data-testid="analysis-experiment-group"][data-experiment="easily-boss-grouse"]')
    .getByTestId("analysis-experiment-files")
  await expect(grouse.getByTestId("analysis-folder")).toHaveText(["animations"])
  await expect(grouse.getByTestId("analysis-file")).toHaveCount(1)
  await openAnalysisFolder(window, "animations")
  await expect(grouse.getByTestId("analysis-file")).toHaveCount(2)
  // multiplexing's experiment keeps plots/ and runs/ as folders.
  await openAnalysisGroup(window, "multiplexing")
  await openAnalysisExperiment(window, "20260214_141942")
  const multiplexing = window
    .locator('[data-testid="analysis-experiment-group"][data-experiment="20260214_141942"]')
    .getByTestId("analysis-experiment-files")
  await expect(multiplexing.getByTestId("analysis-folder")).toHaveText(["plots", "runs"])
  await window.screenshot({
    path: "/private/tmp/claude-501/-Users-enaj-code-PI-Lab/1ca26459-f122-4cc9-9c1d-bc6c1ee58855/scratchpad/analysis-tree.png",
  })
})

test("a results folder laid out like the user's shows the Figures and Markup format rows", async () => {
  // The layout of a real project's results/ (multiplexing/<date>/plots, runs/<name>, …).
  const files = [
    "multiplexing/20260214_141942/best_loss_vs_n.csv",
    "multiplexing/20260214_141942/plots/best_loss_vs_n_log.png",
    "multiplexing/20260214_141942/runs/patterns_conditional_growth/gradient_magnitudes_7hf2hacr.pdf",
    "multiplexing/20260214_141942/runs/patterns_conditional_growth/hidden_states.png",
    "multiplexing/20260214_141942/runs/patterns_conditional_growth/config.yml",
    "multiplexing/20260214_141942/runs/patterns_conditional_growth/states.npy",
    "pattern_translation/fully-witty-marmot/training_curve_lly7qbhx.pdf",
    "pattern_translation/fully-witty-marmot/grid.png",
  ]
  await rm(join(repoDir, "results"), { recursive: true })
  for (const file of files) {
    await mkdir(dirname(join(repoDir, "results", file)), { recursive: true })
    await writeFile(join(repoDir, "results", file), "x")
  }
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  const formats = window.getByTestId("analysis-format-filters").getByRole("button")
  await window.getByTestId("analysis-category-figure").click({ timeout: 30_000 })
  await expect(formats).toHaveText(["PNG", "PDF", "SVG", "JPG"])
  for (const chip of await formats.all()) await expect(chip).toBeVisible()
  await expect(window.getByTestId("analysis-format-png")).toBeEnabled()
  await expect(window.getByTestId("analysis-format-pdf")).toBeEnabled()
  await expect(window.getByTestId("analysis-format-svg")).toBeDisabled()
  // Markup lists its fixed formats; only YAML (the .yml file) has files.
  await window.getByTestId("analysis-category-markup").click()
  await expect(formats).toHaveText(["YAML", "TOML", "JSON", "XML"])
  await expect(window.getByTestId("analysis-format-yaml")).toBeEnabled()
  await expect(window.getByTestId("analysis-format-toml")).toBeDisabled()
  await window.screenshot({ path: resolve(".cache", "screens", "analysis-user-layout.png") })
})

test("Animations lists videos and gifs; a video plays muted and looping, a gif animates", async () => {
  const run = join(repoDir, "results", "multiplexing", "run_a")
  await mkdir(run, { recursive: true })
  await copyFile(join(HERE, "fixtures", "media", "tiny.mp4"), join(run, "growth.mp4"))
  await copyFile(join(HERE, "fixtures", "media", "tiny.gif"), join(run, "growth.gif"))
  await writeFile(join(run, "model.pt"), "weights")
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()

  await window.getByTestId("analysis-category-animation").click({ timeout: 30_000 })
  await expect(window.getByTestId("analysis-format-filters").getByRole("button")).toHaveText([
    "MP4",
    "GIF",
    "WEBM",
    "MOV",
    "MKV",
  ])
  await expect(window.getByTestId("analysis-format-webm")).toBeDisabled()
  // The format row is one line: every chip sits at the same height.
  const tops = await window
    .getByTestId("analysis-format-filters")
    .getByRole("button")
    .evaluateAll((chips) => chips.map((chip) => Math.round(chip.getBoundingClientRect().top)))
  expect(new Set(tops).size).toBe(1)
  await openAnalysisExperiment(window, "multiplexing")
  await openAnalysisFolder(window, "run_a")
  await expect(window.getByTestId("analysis-file")).toHaveCount(2)
  await expect(
    window.locator('[data-testid="analysis-file"][data-rel-path$="model.pt"]'),
  ).toHaveCount(0)

  // The video streams from its media grant and loads (16x16 px), muted and looping.
  await window.locator('[data-testid="analysis-file"][data-rel-path$="growth.mp4"]').click()
  const video = window.getByTestId("analysis-preview-video")
  await expect(video).toHaveAttribute("src", /^pi-lab-media:\/\//, { timeout: 30_000 })
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.videoWidth), {
      timeout: 30_000,
    })
    .toBe(16)
  expect(
    await video.evaluate((element: HTMLVideoElement) => [
      element.muted,
      element.loop,
      element.controls,
      element.error,
    ]),
  ).toEqual([true, true, true, null])
  await window.screenshot({ path: resolve(".cache", "screens", "analysis-video.png") })

  // The gif loads as an image.
  await window.locator('[data-testid="analysis-file"][data-rel-path$="growth.gif"]').click()
  const gif = window.getByTestId("analysis-preview-animation")
  await expect
    .poll(() => gif.evaluate((element: HTMLImageElement) => element.naturalWidth), {
      timeout: 30_000,
    })
    .toBe(16)
})

test("Escape deselects the previewed file, and the folder tree can be hidden from the list or Settings", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  await expect(window.getByTestId("science-analysis")).toBeVisible({ timeout: 30_000 })
  // At the default window size the files column is about 29% of the cards' row.
  await expect
    .poll(
      () =>
        window
          .getByTestId("analysis-files-column")
          .evaluate((el) => el.getBoundingClientRect().width),
      {
        timeout: 30_000,
      },
    )
    .toBe(280)

  await openAnalysisExperiment(window, "exp-a")
  await window
    .locator('[data-testid="analysis-file"][data-rel-path="results/exp-a/plot.png"]')
    .click()
  await expect(window.getByTestId("analysis-preview-path")).toHaveText("results/exp-a/plot.png")
  // Escape in the search box stays with the field.
  await window.getByTestId("analysis-search").focus()
  await window.keyboard.press("Escape")
  await expect(window.getByTestId("analysis-preview-path")).toBeVisible()
  await window.getByTestId("analysis-search").blur()
  await window.keyboard.press("Escape")
  await expect(window.getByTestId("analysis-no-selection")).toHaveText(
    "Select a file to preview its contents.",
  )

  // The toggle next to the Structure select lists the files without folders.
  const toggle = window.getByTestId("analysis-flat-toggle")
  await expect(toggle).toHaveAttribute("aria-pressed", "false")
  await toggle.click()
  await expect(window.getByTestId("analysis-experiment")).toHaveCount(0)
  await expect(window.getByTestId("analysis-file")).toHaveCount(5)
  await expect(
    window.locator('[data-testid="analysis-file"][data-rel-path="results/exp-a/plot.png"]'),
  ).toContainText("results/exp-a/plot.png")
  await window.screenshot({ path: resolve(".cache", "screens", "analysis-flat-list.png") })

  // Settings shows the same choice; turning it off there brings the tree back.
  await window.getByTestId("nav-settings").click()
  await window.getByTestId("settings-nav-experiments").click()
  const setting = window.getByTestId("settings-analysis-flat-list")
  await expect(setting).toHaveAttribute("aria-checked", "true", { timeout: 30_000 })
  await setting.click()
  await expect(setting).toHaveAttribute("aria-checked", "false")
  await window.getByTestId("settings-back").click()
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  await expect(window.getByTestId("analysis-experiment").first()).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("analysis-flat-toggle")).toHaveAttribute("aria-pressed", "false")
})

test("with no results folder, Analysis shows no folder and points to Select experiments folder", async () => {
  await rename(join(repoDir, "results"), join(repoDir, "old-results"))
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  await expect(window.getByTestId("science-analysis")).toBeVisible({ timeout: 30_000 })

  await expect(window.getByTestId("analysis-select-folder-prompt")).toHaveText(
    "Select experiments folder",
    { timeout: 30_000 },
  )
  await expect(window.getByTestId("analysis-results-folder-path")).toHaveCount(0)
  const select = window.getByTestId("analysis-results-folder-change")
  await expect(select).toHaveText("Select…")
  await expect(select).toHaveAttribute("data-highlighted", "true")
  // The accent ring is drawn (it pulses, then stays until the button is clicked).
  expect(await select.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none")
  await window.screenshot({ path: resolve(".cache", "screens", "analysis-select-folder.png") })

  // Choosing a folder (the test picker returns <project>/outputs) lists it.
  await select.click()
  await expect(window.getByTestId("analysis-results-folder-path")).toHaveText("outputs/")
  await expect(window.getByTestId("analysis-select-folder-prompt")).toHaveCount(0)
  await expect(window.getByTestId("analysis-results-folder-change")).toHaveText("Change…")
  await expect(
    window.locator('[data-testid="analysis-experiment"][data-experiment="exp-c"]'),
  ).toBeVisible()
})

/** In the page: how far an element's text runs past its box (0 when it fits). */
async function textOverflow(locator: Locator): Promise<number> {
  return locator.evaluate((element) => element.scrollWidth - element.clientWidth)
}

/** In the page: whether a select's shown option text fits in the select, arrow included. */
async function selectTextFits(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const select = element as HTMLSelectElement
    const style = getComputedStyle(select)
    const context = document.createElement("canvas").getContext("2d")
    if (!context) throw new Error("No canvas")
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    const text = select.selectedOptions[0]?.textContent ?? ""
    const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
    // Leave room for the native arrow.
    return context.measureText(text).width + padding + 16 <= select.clientWidth
  })
}

test("at the default window width the prompt, the Structure select and long group names are not cut", async () => {
  // A long experiment name.
  const longName = "blastocyst-profile-morpheus_s0-sweep-gradient-noise"
  await mkdir(join(repoDir, "results", longName), { recursive: true })
  await writeFile(join(repoDir, "results", longName, "metrics.csv"), "a\n1\n")
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
  expect(await window.evaluate(() => window.innerWidth)).toBe(1280)
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  await expect(window.getByTestId("science-analysis")).toBeVisible({ timeout: 30_000 })

  const structure = window.getByTestId("analysis-structure")
  await expect(structure).toHaveValue("auto", { timeout: 30_000 })
  expect(await selectTextFits(structure)).toBe(true)

  const label = window
    .locator(`[data-testid="analysis-experiment"][data-experiment="${longName}"]`)
    .getByTestId("analysis-experiment-label")
  await expect(label).toHaveAttribute("title", longName, { timeout: 30_000 })
  expect(await textOverflow(label)).toBeLessThanOrEqual(0)
  await window.screenshot({ path: resolve(".cache", "screens", "analysis-default-width.png") })

  // With no results folder, the one-liner is shown in full.
  await rename(join(repoDir, "results"), join(repoDir, "old-results"))
  await window.reload()
  const prompt = window.getByTestId("analysis-select-folder-prompt")
  await expect(prompt).toBeVisible({ timeout: 30_000 })
  expect(await textOverflow(prompt)).toBeLessThanOrEqual(0)
  await expect(window.getByTestId("analysis-structure")).toHaveValue("auto")
  expect(await selectTextFits(window.getByTestId("analysis-structure"))).toBe(true)
  await window.screenshot({
    path: resolve(".cache", "screens", "analysis-default-width-prompt.png"),
  })
})

test("Report shows an error without the report skill, then starts the project's agent with it", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
  // Seed the remembered fixture agent; the launch still crosses the real PTY boundary.
  await execFileAsync("/usr/bin/sqlite3", [
    join(dataDir, "local.db"),
    `UPDATE projects SET agent_config='{"agentId":"test-echo"}'`,
  ])
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  await expect(window.getByTestId("science-analysis")).toBeVisible({ timeout: 30_000 })
  const report = window.getByTestId("analysis-report")
  // An icon-only top bar button, named in its hover tip.
  await expect(report).toHaveText("")
  await expect(report).toHaveAttribute("data-feature-label", "Report")
  await expect(report).toBeEnabled({ timeout: 30_000 })

  // No experiment-report skill in the user skills folders yet: a clear error, no session.
  await report.click()
  await expect(window.getByTestId("analysis-shortcut-error")).toContainText(
    'The report skill "experiment-report" was not found',
    { timeout: 30_000 },
  )

  const skillDir = join(dataDir, "home", ".agents", "skills", "experiment-report")
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: experiment-report\ndescription: Build a report\n---\nBuild the report.\n",
  )
  await report.click()
  const panel = window.getByTestId("science-sessions")
  await expect(panel).toHaveAttribute("data-collapsed", "false", { timeout: 30_000 })
  await expect(panel.getByTestId("terminal")).toContainText("AGENT-UI-OK", { timeout: 15_000 })
  await expect(panel.getByTestId("central-tab-select").filter({ hasText: "Report" })).toBeVisible()
  await expect(window.getByTestId("analysis-shortcut-error")).toHaveCount(0)
})

test("interactive HTML is sandboxed while scripts, relative assets, and network fetch work", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()

  await openAnalysisExperiment(window, "reports")
  await window
    .locator('[data-testid="analysis-file"][data-rel-path="results/reports/interactive.html"]')
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

  await openAnalysisExperiment(window, "reports")
  await openAnalysisExperiment(window, "data")
  const marimoRow = window.locator(
    '[data-testid="analysis-file"][data-rel-path="results/reports/live.py"]',
  )
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

test("Analysis owns Fetch experiments and keeps existing Marimo notebooks", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  await expect(window.getByTestId("analysis-new-marimo-notebook")).toHaveCount(0)
  await openAnalysisExperiment(window, "reports")
  await expect(
    window.locator('[data-testid="analysis-file"][data-rel-path="results/reports/live.py"]'),
  ).toBeVisible()
  await window.getByTestId("analysis-fetch-experiments").click()
  await expect(window.getByTestId("workflow-result-dialog")).toBeVisible()
  await expect(window.getByTestId("workflow-result-text")).toBeVisible({ timeout: 30_000 })
})

/** Drag a resize handle horizontally by `dx` px with the real mouse. */
async function dragHandle(window: Page, testId: string, dx: number): Promise<void> {
  const box = await window.getByTestId(testId).boundingBox()
  if (!box) throw new Error(`No ${testId} handle`)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await window.mouse.move(x, y)
  await window.mouse.down()
  await window.mouse.move(x + dx, y, { steps: 8 })
  await window.mouse.up()
}

/** A locator's rendered width in px. */
async function widthOf(locator: Locator): Promise<number> {
  return locator.evaluate((element) => element.getBoundingClientRect().width)
}

/**
 * Real app: the gap between the file list and the preview, and the gap between
 * the preview and the right panel, both drag to resize; each width is saved and
 * comes back after a reload. Tasks uses the same right panel width. Like the
 * project view, each part is its own rounded card with 12px gaps between them.
 */
test("Analysis file list and right panel resize from the gaps and keep the size after reload", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 900))
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
  const analysisNav = window.locator(
    '[data-testid="science-nav-item"][data-science-tab="analysis"]',
  )
  await analysisNav.click()
  await expect(window.getByTestId("science-analysis")).toBeVisible({ timeout: 30_000 })

  const files = window.getByTestId("analysis-files-column")
  const panel = window.getByTestId("science-sessions")
  await expect(panel).toHaveAttribute("data-collapsed", "false")
  const sidebar = panel.getByTestId("right-sidebar")
  await expect(sidebar).toBeVisible({ timeout: 30_000 })
  // The panel opens on the Sessions tab, and both side columns start at their minimums.
  await expect(panel.getByTestId("panel-tab-sessions")).toHaveAttribute("aria-selected", "true")
  const filesBefore = await widthOf(files)
  const panelBefore = await widthOf(panel)
  // The files column starts at its default (280 px, about 29% of the content width).
  expect(filesBefore).toBe(280)
  expect(panelBefore).toBe(235)

  await dragHandle(window, "analysis-files-edge-drag", 80)
  await expect.poll(() => widthOf(files)).toBe(filesBefore + 80)
  await dragHandle(window, "science-sessions-edge-drag", -100)
  await expect.poll(() => widthOf(panel)).toBe(panelBefore + 100)

  // Like the project view, the file list, the preview and the right panel are
  // separate rounded cards 12px apart, with no line of their own outside a card. The
  // right panel is one card, the project view's right sidebar with a Sessions tab
  // first; its tabs and its collapse button sit in its tab row.
  const box = await sidebar.boundingBox()
  const aside = await panel.boundingBox()
  const filesBox = await files.boundingBox()
  const preview = await window.getByTestId("analysis-preview-column").boundingBox()
  const sessionsTab = await panel.getByTestId("panel-tab-sessions").boundingBox()
  const collapse = await panel.getByTestId("right-sidebar-collapse").boundingBox()
  if (!box || !aside || !filesBox || !preview || !sessionsTab || !collapse) {
    throw new Error("No Analysis layout")
  }
  expect(Math.round(preview.x - (filesBox.x + filesBox.width))).toBe(12)
  expect(Math.round(aside.x - (preview.x + preview.width))).toBe(12)
  expect(Math.round(box.x)).toBe(Math.round(aside.x))
  expect(Math.round(box.x + box.width)).toBe(Math.round(aside.x + aside.width))
  expect(Math.round(box.y)).toBe(Math.round(aside.y))
  expect(Math.round(box.y + box.height)).toBe(Math.round(aside.y + aside.height))
  await expect(panel.getByTestId("right-sidebar")).toHaveCount(1)
  for (const inner of [sessionsTab, collapse]) {
    expect(inner.y).toBeGreaterThanOrEqual(box.y)
    expect(inner.y + inner.height).toBeLessThanOrEqual(box.y + 40)
    expect(inner.x + inner.width).toBeLessThanOrEqual(box.x + box.width)
  }
  const cardStyle = (locator: Locator) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element)
      return `${style.borderTopLeftRadius} ${style.borderLeftWidth}`
    })
  for (const card of [
    files.locator(":scope > div.rounded-lg"),
    window.getByTestId("analysis-preview-column"),
    sidebar,
  ]) {
    expect(await cardStyle(card)).toBe("8px 1px")
  }
  // The Sessions tab shows the central panel inside the card, with no border of its own.
  await panel.getByTestId("panel-tab-sessions").click()
  await expect(panel.getByTestId("central-panel")).toBeVisible({ timeout: 30_000 })
  expect(await cardStyle(panel.getByTestId("central-panel"))).toBe("0px 0px")
  for (const frame of [files, panel]) {
    expect(await frame.evaluate((element) => getComputedStyle(element).borderLeftWidth)).toBe("0px")
    expect(await frame.evaluate((element) => getComputedStyle(element).borderRightWidth)).toBe(
      "0px",
    )
  }
  await window.screenshot({ path: resolve(".cache", "screens", "analysis-resized.png") })

  // The reload stays on Analysis.
  await window.reload()
  await expect(window.getByTestId("science-analysis")).toBeVisible({ timeout: 30_000 })
  await expect(panel).toHaveAttribute("data-collapsed", "false")
  await expect.poll(() => widthOf(files)).toBe(filesBefore + 80)
  await expect.poll(() => widthOf(panel)).toBe(panelBefore + 100)

  // Tasks shows the same right panel at the saved width.
  await window.locator('[data-testid="science-nav-item"][data-science-tab="tasks"]').click()
  await expect(window.getByTestId("science-tasks")).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => widthOf(panel)).toBe(panelBefore + 100)
})

/**
 * Every card's right edge, and the row's scroll width, stay inside the view minus
 * its 12px margin: nothing is cut off and nothing scrolls sideways.
 */
async function expectCardsInside(window: Page, viewTestId: string, cards: Locator[]) {
  const view = await window.getByTestId(viewTestId).boundingBox()
  if (!view) throw new Error(`No ${viewTestId}`)
  for (const card of cards) {
    if ((await card.count()) === 0) continue
    const box = await card.first().boundingBox()
    if (!box) continue
    expect(Math.round(box.x + box.width)).toBeLessThanOrEqual(Math.round(view.x + view.width - 12))
  }
  // The view and each card's row hold their content: nothing overflows sideways.
  for (const element of [window.getByTestId(viewTestId), ...cards]) {
    if ((await element.count()) === 0) continue
    const overflow = await element.first().evaluate((node) => {
      const holder =
        node.hasAttribute("data-testid") && node.parentElement ? node.parentElement : node
      return holder.scrollWidth - holder.clientWidth
    })
    expect(overflow).toBeLessThanOrEqual(1)
  }
}

/**
 * Real app: at 1100x800 and 900x700 the Analysis and Tasks cards fit the window.
 * Short of room the right panel is drawn collapsed without changing the saved
 * choice: expanding it squeezes the other cards to their minimums, and a wide
 * window shows it open again.
 */
test("Analysis and Tasks cards fit narrow windows, collapsing the right panel when needed", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
  const setSize = (width: number, height: number) =>
    app.evaluate(
      ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]?.setSize(w, h),
      [width, height],
    )
  const panel = window.getByTestId("science-sessions")
  const analysisCards = [
    window.getByTestId("analysis-files-column"),
    window.getByTestId("analysis-preview-column"),
    panel,
    panel.getByTestId("right-sidebar"),
  ]
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  await expect(window.getByTestId("science-analysis")).toBeVisible({ timeout: 30_000 })
  await expect(panel).toHaveAttribute("data-collapsed", "false")

  await setSize(1100, 800)
  await expect(panel).toHaveAttribute("data-collapsed", "false")
  await expect(panel.getByTestId("right-sidebar")).toBeVisible({ timeout: 30_000 })
  await expectCardsInside(window, "science-analysis", analysisCards)

  await setSize(900, 700)
  await expect(panel).toHaveAttribute("data-collapsed", "true")
  await expectCardsInside(window, "science-analysis", analysisCards)
  // Expanding makes room: the panel opens and every card still fits.
  await window.getByTestId("science-sessions-expand").click()
  await expect(panel).toHaveAttribute("data-collapsed", "false")
  await expectCardsInside(window, "science-analysis", analysisCards)
  await window.screenshot({ path: resolve(".cache", "screens", "analysis-900-expanded.png") })
  await panel.getByTestId("right-sidebar-collapse").click()
  await expect(panel).toHaveAttribute("data-collapsed", "true")
  await window.getByTestId("science-sessions-expand").click()
  await setSize(1400, 900)
  await expect(panel).toHaveAttribute("data-collapsed", "false")
  // Short of room again, the panel is drawn collapsed; the saved choice is still open.
  await setSize(900, 700)
  await expect(panel).toHaveAttribute("data-collapsed", "true")
  await setSize(1400, 900)
  await expect(panel).toHaveAttribute("data-collapsed", "false")

  await window.locator('[data-testid="science-nav-item"][data-science-tab="tasks"]').click()
  await expect(window.getByTestId("science-tasks")).toBeVisible({ timeout: 30_000 })
  const tasksCards = [window.getByTestId("tasks-board"), panel]
  for (const [width, height] of [
    [1100, 800],
    [900, 700],
  ]) {
    await setSize(width, height)
    await expect(window.getByTestId("tasks-board")).toBeVisible()
    await expect
      .poll(async () => {
        const board = await window.getByTestId("tasks-board").boundingBox()
        return board ? Math.round(board.width) : 0
      })
      .toBeGreaterThanOrEqual(320)
    await expectCardsInside(window, "science-tasks", tasksCards)
  }
})
