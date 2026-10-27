import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { _electron as electron, expect, type Locator, test } from "@playwright/test"

const execFileAsync = promisify(execFile)
const ORIGINAL = "Synchronization target in the included chapter."
const UPDATED = "Refreshed target in the included chapter."
const REFRESHED_AGAIN = "Another refresh in the included chapter."
const RECOVERED = "Successful external output after the failed build."
const FAILED_OUTPUT = "Changed output from a failed compilation."
const SAVED = "Saved target in the included chapter."
const MAIN = String.raw`\documentclass{article}
\begin{document}
First page of the PDF viewer fixture.
\newpage
\input{chapter}
\end{document}
`

/** Compile real output and SyncTeX mappings, including a separate source file. */
async function compileFixture(repo: string): Promise<void> {
  await execFileAsync(
    "latexmk",
    ["-pdf", "-synctex=1", "-interaction=nonstopmode", "-outdir=build", "main.tex"],
    {
      cwd: repo,
      timeout: 30_000,
      maxBuffer: 2_000_000,
    },
  )
}

/** Build controls stay on the bottom baseline, and their logs open above it. */
async function checkBuildFooter(panel: Locator, footer: Locator): Promise<void> {
  const status = footer.getByTestId("latex-build-status")
  await expect(status).toBeVisible()
  const panelBounds = await panel.boundingBox()
  const footerBounds = await footer.boundingBox()
  if (!panelBounds || !footerBounds) throw new Error("Expected visible panel and footer")
  expect(
    Math.abs(panelBounds.y + panelBounds.height - footerBounds.y - footerBounds.height),
  ).toBeLessThan(4)
  await status.click()
  const log = panel.getByTestId("latex-build-log")
  await expect(log).toBeVisible()
  await expect(log).toContainText("Latexmk")
  const logBounds = await log.boundingBox()
  if (!logBounds) throw new Error("Expected visible build log")
  expect(logBounds.y + logBounds.height).toBeLessThanOrEqual(footerBounds.y + 1)
  await status.click()
  await expect(log).toBeHidden()
}

/** Exercise the real filesystem, Electron IPC, PDF.js rendering, and TeX toolchain. */
test("PDF viewer refreshes compiled output and navigates both ways through SyncTeX", async () => {
  test.setTimeout(120_000)
  for (const tool of ["latexmk", "pdflatex", "synctex"]) {
    const available = await execFileAsync(tool, ["--version"]).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      },
    )
    test.skip(!available, `Real PDF/SyncTeX test requires ${tool} on PATH`)
  }
  const root = await mkdtemp(join(tmpdir(), "pi-lab-pdf-e2e-"))
  const repo = join(root, "paper")
  await mkdir(repo)
  await writeFile(join(repo, "main.tex"), MAIN)
  await writeFile(join(repo, "chapter.tex"), `% !TeX root = main.tex\n\n${ORIGINAL}\n`)
  await compileFixture(repo)
  const desktop = resolve("apps/desktop")
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional packaged target for this direct Playwright check outside Turbo.
  const binary = process.env.PI_LAB_PACKAGED_BINARY
  const app = await electron.launch({
    timeout: 30_000,
    executablePath: binary ?? (createRequire(join(desktop, "package.json"))("electron") as string),
    args: binary ? [] : [join(desktop, "out/main/index.js")],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_TEST_HIDE_WINDOWS: "1",
      PI_LAB_DATA_DIR: root,
      PI_LAB_SOCKET_PATH: join(root, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: repo,
    },
  })
  const fixtureProcess = app.process()
  try {
    const page = await app.firstWindow()
    const pageErrors: string[] = []
    const workerFailures: string[] = []
    const pdfWorkers: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.message))
    page.on("worker", (worker) => {
      if (worker.url().includes("pdf.worker")) pdfWorkers.push(worker.url())
    })
    page.on("console", (message) => {
      const text = message.text()
      if (
        /fake worker|content security policy|refused to (?:create|load|execute).*worker/i.test(text)
      ) {
        workerFailures.push(text)
      }
    })
    await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await page.getByTestId("project-item").click()
    await page.getByTestId("panel-tab-files").click()
    await page.getByTestId("file-tree-dir").filter({ hasText: "build" }).click()
    await page.getByTestId("file-tree-file").filter({ hasText: "main.pdf" }).click()
    const viewer = page.getByTestId("pdf-viewer")
    await expect(viewer).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId("editor-rejected-read")).toHaveCount(0)
    await expect(viewer.locator(".page canvas").first()).toBeVisible()
    await expect(viewer.locator(".textLayer").first()).toContainText("First page")

    const pageNumber = page.getByTestId("pdf-page-number")
    await pageNumber.fill("2")
    await pageNumber.press("Enter")
    await page.getByTestId("pdf-zoom").selectOption("1.25")
    await expect(viewer.locator(".textLayer").filter({ hasText: ORIGINAL })).toBeVisible()
    await expect(pageNumber).toHaveValue("2")

    const scrollBeforeRefresh = await viewer
      .locator(".pi-pdf-pages:visible")
      .evaluate((element) => element.scrollTop)
    // A compiler running outside PI Lab replaces the same PDF; the preview must
    // reload fresh bytes while keeping the current page and zoom.
    await writeFile(join(repo, "chapter.tex"), `% !TeX root = main.tex\n\n${UPDATED}\n`)
    await compileFixture(repo)
    await expect(viewer.locator(".textLayer").filter({ hasText: UPDATED })).toBeVisible({
      timeout: 15_000,
    })
    await expect(pageNumber).toHaveValue("2")
    await expect(page.getByTestId("pdf-zoom")).toHaveValue("1.25")
    const scrollAfterRefresh = await viewer
      .locator(".pi-pdf-pages:visible")
      .evaluate((element) => element.scrollTop)
    expect(Math.abs(scrollAfterRefresh - scrollBeforeRefresh)).toBeLessThan(3)

    // Reverse SyncTeX must open the included file, not merely the root document.
    const target = viewer.locator(".textLayer span").filter({ hasText: UPDATED }).first()
    await target.dblclick()
    const editor = page.getByTestId("editor-buffer")
    await expect(editor).toBeVisible()
    await expect(editor).toContainText(UPDATED)
    await expect(
      page.getByTestId("central-tab-select").filter({ hasText: "chapter.tex" }),
    ).toBeVisible()
    const selectedLine = await editor.locator(".cm-content").evaluate((element) => {
      const selection = window.getSelection()
      const anchor = selection?.anchorNode
      const line = anchor?.parentElement?.closest(".cm-line")
      return element.contains(anchor ?? null) ? line?.textContent : null
    })
    expect(selectedLine).toContain(UPDATED)

    // Move the preview away first, so merely switching tabs cannot pass the
    // forward-sync assertion. It must navigate from page 1 back to page 2.
    await page.getByTestId("central-tab-select").filter({ hasText: "main.pdf" }).click()
    await pageNumber.fill("1")
    await pageNumber.press("Enter")
    await expect(pageNumber).toHaveValue("1")
    await page.getByTestId("central-tab-select").filter({ hasText: "chapter.tex" }).click()
    await editor.locator(".cm-line").filter({ hasText: UPDATED }).dblclick()
    await expect(viewer).toBeVisible()
    await expect(pageNumber).toHaveValue("2")
    await expect(viewer.locator(".textLayer").filter({ hasText: UPDATED })).toBeVisible()

    await expect(
      viewer.locator(".textLayer span").filter({ hasText: UPDATED }).first(),
    ).toBeInViewport({ ratio: 0.8 })

    // A consumed SyncTeX target must not pull the reader back to page 2 when
    // a later build refreshes the PDF while they are reading page 1.
    await pageNumber.fill("1")
    await pageNumber.press("Enter")
    const previousSurface = await viewer.locator(".pi-pdf-pages:visible").elementHandle()
    if (!previousSurface) throw new Error("Expected a rendered PDF surface")
    await writeFile(join(repo, "chapter.tex"), `% !TeX root = main.tex\n\n${REFRESHED_AGAIN}\n`)
    await compileFixture(repo)
    await expect(viewer.locator(".textLayer").filter({ hasText: REFRESHED_AGAIN })).toBeAttached({
      timeout: 15_000,
    })
    await expect(pageNumber).toHaveValue("1")
    await pageNumber.fill("2")
    await pageNumber.press("Enter")
    await expect(
      viewer.locator(".textLayer span").filter({ hasText: REFRESHED_AGAIN }).first(),
    ).toBeInViewport({ ratio: 0.8 })

    // A partially written or invalid replacement must leave the last good PDF
    // visible, and a later valid replacement must recover without reopening it.
    const goodPdf = await readFile(join(repo, "build", "main.pdf"))
    await writeFile(join(repo, "build", "main.pdf"), "invalid PDF replacement")
    await expect(viewer.getByRole("alert")).toContainText("Could not load PDF", { timeout: 15_000 })
    await expect(
      viewer.locator(".textLayer span").filter({ hasText: REFRESHED_AGAIN }).first(),
    ).toBeInViewport({ ratio: 0.8 })
    await writeFile(join(repo, "build", "main.pdf"), goodPdf)
    await expect(viewer.getByRole("alert")).toHaveCount(0, { timeout: 15_000 })
    await expect(pageNumber).toHaveValue("2")

    // Saving edited TeX invokes the actual compiler and refreshes its output.
    await page.getByTestId("central-tab-select").filter({ hasText: "chapter.tex" }).click()
    await expect(editor).toContainText(REFRESHED_AGAIN, { timeout: 10_000 })
    await editor.locator(".cm-content").click()
    await page.keyboard.press("ControlOrMeta+a")
    await page.keyboard.insertText(`% !TeX root = main.tex\n\n${SAVED}\n`)
    await page.keyboard.press("ControlOrMeta+s")
    await expect.poll(() => readFile(join(repo, "chapter.tex"), "utf8")).toContain(SAVED)
    await expect(page.locator('[data-testid="latex-build-status"]:visible')).toContainText(
      /built|complete|success/i,
      {
        timeout: 30_000,
      },
    )
    await checkBuildFooter(page.getByTestId("central-panel"), page.getByTestId("editor-status-bar"))
    await page.getByTestId("latex-show-pdf").click()
    await expect(viewer.locator(".textLayer").filter({ hasText: SAVED })).toBeVisible({
      timeout: 15_000,
    })
    await expect(
      viewer.locator(".textLayer span").filter({ hasText: SAVED }).first(),
    ).toBeInViewport({ ratio: 0.8 })
    await checkBuildFooter(page.getByTestId("central-panel"), viewer.getByTestId("pdf-status"))
    await page.screenshot({ path: test.info().outputPath("pdf-viewer.png") })
    // Recoverable TeX errors can still produce a changed, valid PDF. The viewer
    // must retain the successful version rather than display that failed output.
    const successfulPdf = await readFile(join(repo, "build", "main.pdf"))
    await page.getByTestId("file-tree-file").filter({ hasText: "main.tex" }).click()
    await editor.locator(".cm-content").click()
    await page.keyboard.press("ControlOrMeta+a")
    await page.keyboard.insertText(String.raw`\documentclass{article}
\begin{document}
\undefinedPiLabCommand
First page from a failed compilation.
\newpage
${FAILED_OUTPUT}
\end{document}
`)
    await page.keyboard.press("ControlOrMeta+s")
    await expect(page.locator('[data-testid="latex-build-status"]:visible')).toContainText(
      "LaTeX build failed",
      {
        timeout: 30_000,
      },
    )
    const failedPdf = await readFile(join(repo, "build", "main.pdf"))
    expect(
      failedPdf.equals(successfulPdf),
      "The failed compiler must have written different PDF output",
    ).toBe(false)
    await page.getByTestId("central-tab-select").filter({ hasText: "main.pdf" }).click()
    await expect(page.getByTestId("pdf-status")).toContainText("showing previous PDF", {
      timeout: 15_000,
    })
    await expect(
      viewer.locator(".textLayer span").filter({ hasText: SAVED }).first(),
    ).toBeInViewport({ ratio: 0.8 })
    await expect(viewer.locator(".textLayer").filter({ hasText: FAILED_OUTPUT })).toHaveCount(0)
    // Suppressing one failed build must not suppress subsequent valid output
    // written by an external compiler.
    await writeFile(join(repo, "main.tex"), MAIN)
    await writeFile(join(repo, "chapter.tex"), `% !TeX root = main.tex\n\n${RECOVERED}\n`)
    await compileFixture(repo)
    await expect(
      viewer.locator(".textLayer span").filter({ hasText: RECOVERED }).first(),
    ).toBeInViewport({ ratio: 0.8, timeout: 15_000 })
    await expect(page.getByTestId("pdf-status")).toContainText("PDF up to date")
    expect(pdfWorkers.length, "PDF rendering must use a real background worker").toBeGreaterThan(0)
    expect(workerFailures).toEqual([])
    expect(pageErrors).toEqual([])
  } finally {
    const forceExit = setTimeout(() => fixtureProcess.kill("SIGKILL"), 5_000)
    await app
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
      })
      .catch(() => undefined)
    await app.close().catch(() => fixtureProcess.kill("SIGKILL"))
    clearTimeout(forceExit)
    await rm(root, { recursive: true, force: true })
  }
})
