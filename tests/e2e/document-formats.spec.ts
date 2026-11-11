import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  test,
} from "./fixtures/playwright"

/**
 * Whole-app E2E for document formats: set a project's analysis format in Edit
 * project, then preview a Jupyter notebook and an HTML report in Analysis.
 * Runs under Node (Playwright's `_electron` launcher hangs under Bun).
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string
const execFileAsync = promisify(execFile)

/** A 1×1 transparent PNG, base64. */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

const NOTEBOOK = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    { cell_type: "markdown", metadata: {}, source: ["# Loss curve\n", "The loss went down."] },
    {
      cell_type: "code",
      metadata: {},
      execution_count: 1,
      source: ["print('final loss 0.3')\n", "plot(loss)"],
      outputs: [
        { output_type: "stream", name: "stdout", text: ["final loss 0.3\n"] },
        { output_type: "display_data", metadata: {}, data: { "image/png": TINY_PNG } },
      ],
    },
  ],
}

let app: ElectronApplication
let dataDir: string
let repoDir: string

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-document-formats-"))
  repoDir = join(dataDir, "repo")
  await mkdir(join(repoDir, "results", "run"), { recursive: true })
  await execFileAsync("git", ["init", "-b", "main", repoDir])
  await writeFile(join(repoDir, "results", "run", "analysis.ipynb"), JSON.stringify(NOTEBOOK))
  await writeFile(
    join(repoDir, "results", "run", "report.html"),
    "<!doctype html><h1 id='title'>Run report</h1>",
  )
  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: repoDir,
    },
  })
})

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("Edit project sets the analysis format, and Analysis previews an .ipynb and an .html file", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  const openEdit = async () => {
    await window.getByTestId("project-item").click({ button: "right" })
    await window.getByTestId("project-edit").click()
    await expect(window.getByTestId("edit-project-dialog")).toBeVisible()
  }
  await openEdit()
  const format = window.getByTestId("edit-project-analysis-format")
  await expect(format).toHaveValue("")
  await format.selectOption("ipynb")
  await window.getByTestId("edit-project-save").click()
  await expect(window.getByTestId("edit-project-dialog")).toHaveCount(0)
  await openEdit()
  await expect(window.getByTestId("edit-project-analysis-format")).toHaveValue("ipynb")
  await window.getByTestId("edit-project-cancel").click()

  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  await expect(window.getByTestId("science-analysis")).toBeVisible({ timeout: 30_000 })

  await window
    .locator('[data-testid="analysis-file"][data-rel-path="results/run/analysis.ipynb"]')
    .click()
  const pane = window.getByTestId("analysis-preview")
  await expect(pane.getByRole("heading", { name: "Loss curve" })).toBeVisible({ timeout: 30_000 })
  await expect(pane.getByTestId("analysis-notebook-code")).toHaveText(
    "print('final loss 0.3')\nplot(loss)",
  )
  await expect(pane.getByText("final loss 0.3", { exact: true })).toBeVisible()
  await expect(pane.getByRole("img")).toHaveAttribute("src", `data:image/png;base64,${TINY_PNG}`)

  await window
    .locator('[data-testid="analysis-file"][data-rel-path="results/run/report.html"]')
    .click()
  const report = window.frameLocator('[data-testid="analysis-preview-html"]')
  await expect(report.locator("#title")).toHaveText("Run report", { timeout: 30_000 })
})
