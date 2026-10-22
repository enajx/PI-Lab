import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const DESKTOP = join(ROOT, "apps", "desktop")
const MAIN = join(DESKTOP, "out", "main", "index.js")
const ELECTRON = createRequire(join(DESKTOP, "package.json"))("electron") as string
const execFileAsync = promisify(execFile)

/** Wrap numeric bytes in a version 1 NumPy file. */
function numpyFile(descr: string, fortran: boolean, shape: string, data: Buffer): Buffer {
  let header = `{'descr': '${descr}', 'fortran_order': ${fortran ? "True" : "False"}, 'shape': (${shape}), }`
  header += `${" ".repeat((64 - ((10 + header.length + 1) % 64)) % 64)}\n`
  const prefix = Buffer.alloc(10)
  prefix[0] = 0x93
  prefix.write("NUMPY", 1, "ascii")
  prefix[6] = 1
  prefix.writeUInt16LE(header.length, 8)
  return Buffer.concat([prefix, Buffer.from(header, "ascii"), data])
}

/** A big-endian, Fortran-order grid with one nonfinite cell. */
function numpyGrid(): Buffer {
  const data = Buffer.alloc(48)
  for (const [index, value] of [1, 4, 2, 5, 3, Number.NaN].entries()) {
    data.writeDoubleBE(value, index * 8)
  }
  return numpyFile(">f8", true, "2, 3", data)
}

/** A source grid wider and taller than both display limits. */
function largeNumpyGrid(): Buffer {
  const data = Buffer.alloc(1000 * 800 * 8)
  data.writeDoubleLE(11, 0)
  data.writeDoubleLE(22, (199 * 800 + 31) * 8)
  return numpyFile("<f8", false, "1000, 800", data)
}

/** A series long enough that the chart must stride to 1,000 points. */
function largeNumpySeries(): Buffer {
  const data = Buffer.alloc(1_000_000 * 8)
  data.writeDoubleLE(17, 0)
  data.writeDoubleLE(29, 1000 * 8)
  return numpyFile("<f8", false, "1000000,", data)
}

test("Analysis keeps research output, previews bounded NumPy arrays and reports skipped children", async () => {
  test.setTimeout(120_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-analysis-bounds-"))
  const repo = join(dataDir, "repo")
  await execFileAsync("git", ["init", "-b", "main", repo])
  await execFileAsync("git", ["-C", repo, "config", "user.email", "test@pi-lab.local"])
  await execFileAsync("git", ["-C", repo, "config", "user.name", "PI Lab Test"])
  await mkdir(join(repo, "build"))
  await mkdir(join(repo, "private"))
  await writeFile(join(repo, "build", "matrix.npy"), numpyGrid())
  await writeFile(join(repo, "private", "data.csv"), "a\n1\n")
  await execFileAsync("git", ["-C", repo, "add", "."])
  await execFileAsync("git", ["-C", repo, "commit", "-m", "fixture"])
  await writeFile(join(repo, "build", "large-grid.npy"), largeNumpyGrid())
  await writeFile(join(repo, "build", "long-series.npy"), largeNumpySeries())
  await chmod(join(repo, "private"), 0)

  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({
      executablePath: ELECTRON,
      args: [MAIN],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: dataDir,
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
        PI_LAB_TEST_OPEN_PROJECT: repo,
      },
    })
    const window = await app.firstWindow()
    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
    await window.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
    const matrix = window.locator('[data-testid="analysis-file"][data-rel-path="build/matrix.npy"]')
    await expect(matrix).toBeVisible({ timeout: 30_000 })
    await expect(window.getByTestId("analysis-partial")).toContainText("1")
    await matrix.click()
    const grid = window.getByTestId("analysis-preview-array")
    await expect(grid).toBeVisible()
    await expect(grid.locator("tbody tr")).toHaveCount(2)
    await expect(grid.locator("tbody tr").first().locator("td")).toHaveText(["0", "1", "2", "3"])
    await expect(grid.locator("tbody tr").last().locator("td")).toHaveText(["1", "4", "5", ""])

    await window
      .locator('[data-testid="analysis-file"][data-rel-path="build/large-grid.npy"]')
      .click()
    const largeGrid = window.getByTestId("analysis-preview-array")
    await expect(largeGrid).toBeVisible()
    await expect(largeGrid.locator("thead th")).toHaveCount(33)
    await expect(largeGrid.locator("tbody tr")).toHaveCount(200)
    await expect(largeGrid.locator("tbody tr").first().locator("td").nth(1)).toHaveText("11")
    await expect(largeGrid.locator("tbody tr").last().locator("td").last()).toHaveText("22")
    await expect(window.getByTestId("analysis-preview")).toContainText("Array truncated")

    await window
      .locator('[data-testid="analysis-file"][data-rel-path="build/long-series.npy"]')
      .click()
    await expect(window.getByTestId("analysis-preview-chart")).toBeVisible()
    await expect(window.getByTestId("analysis-preview")).toContainText("Chart downsampled")
  } finally {
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
    }
    await chmod(join(repo, "private"), 0o755)
    await rm(dataDir, { recursive: true, force: true })
  }
})
