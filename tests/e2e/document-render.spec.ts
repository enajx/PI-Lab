import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
  test,
} from "./fixtures/playwright"

/**
 * Whole-app E2E for rendering a Quarto file in Analysis. `quarto` here is a
 * stand-in shell script (not the real Quarto) in PI Lab's tools folder inside
 * the test data folder, which PI Lab searches before PATH. It writes an HTML
 * file where `quarto render --output-dir` would. Runs under Node.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string
const execFileAsync = promisify(execFile)

const STAND_IN_QUARTO = `#!/bin/sh
# Stand-in for quarto, for this test only.
if [ "$1" = "--version" ]; then echo 9.9.9-stand-in; exit 0; fi
mkdir -p "$6"
stem=$(basename "$2" .qmd)
echo "<!doctype html><h1 id='rendered'>Rendered $2</h1>" > "$6/$stem.html"
echo "Output created: $6/$stem.html"
`

let app: ElectronApplication
let dataDir: string
let repoDir: string

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-document-render-"))
  repoDir = join(dataDir, "repo")
  await mkdir(join(repoDir, "results", "run"), { recursive: true })
  await execFileAsync("git", ["init", "-b", "main", repoDir])
  await writeFile(
    join(repoDir, "results", "run", "analysis.qmd"),
    "---\ntitle: Run analysis\n---\n\n# Source heading\n",
  )
  const quarto = join(dataDir, "tools", "quarto", "bin", "quarto")
  await mkdir(dirname(quarto), { recursive: true })
  await writeFile(quarto, STAND_IN_QUARTO)
  await chmod(quarto, 0o755)
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

test("Render in Analysis renders a .qmd and shows the HTML in the preview", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
  await expect(window.getByTestId("science-analysis")).toBeVisible({ timeout: 30_000 })

  await openAnalysisExperiment(window, "run")
  await window
    .locator('[data-testid="analysis-file"][data-rel-path="results/run/analysis.qmd"]')
    .click()
  const pane = window.getByTestId("analysis-preview")
  await expect(pane.getByRole("heading", { name: "Source heading" })).toBeVisible({
    timeout: 30_000,
  })

  await window.getByTestId("document-render").click()
  const page = window.frameLocator('[data-testid="analysis-preview-html"]')
  await expect(page.locator("#rendered")).toHaveText("Rendered analysis.qmd", { timeout: 30_000 })
  await expect(window.getByTestId("document-render-log")).toContainText("Output created")
  await expect(window.getByTestId("document-open-in-browser")).toBeVisible()
  const exclude = await readFile(join(repoDir, ".git", "info", "exclude"), "utf8")
  expect(exclude.split("\n")).toContain("/results/run/_render/")
})
