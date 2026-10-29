import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { _electron as electron, expect, type Locator, test } from "./fixtures/playwright"

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

/** Scroll the visible PDF surface so the given page starts at its top. */
async function scrollToPdfPage(viewer: Locator, pageNumber: number): Promise<void> {
  await viewer.locator(".pi-pdf-pages:visible").evaluate((container, target) => {
    const element = container.querySelector<HTMLElement>(`.page[data-page-number="${target}"]`)
    if (!element) throw new Error(`Expected PDF page ${target}`)
    container.scrollTop = element.offsetTop
  }, pageNumber)
}

/** Dispatch a wheel event on the visible PDF surface; true when the viewer consumed it. */
async function wheelPdf(
  viewer: Locator,
  init: { ctrlKey?: boolean; shiftKey?: boolean; deltaX?: number; deltaY?: number },
): Promise<boolean> {
  return viewer.locator(".pi-pdf-pages:visible").evaluate((container, options) => {
    const event = new WheelEvent("wheel", { ...options, bubbles: true, cancelable: true })
    container.dispatchEvent(event)
    return event.defaultPrevented
  }, init)
}

/**
 * Zoom with a wheel at a point of the visible PDF surface, given as fractions of its
 * size, and return how far (px) the page point that was under the pointer moved.
 * The event goes to the element under the pointer, as a real trackpad event does.
 */
async function zoomDriftAt(
  viewer: Locator,
  at: { x: number; y: number },
  init: { ctrlKey?: boolean; shiftKey?: boolean; deltaY: number },
): Promise<number> {
  return viewer.locator(".pi-pdf-pages:visible").evaluate(
    async (container, { at, init }) => {
      const bounds = container.getBoundingClientRect()
      const x = bounds.left + bounds.width * at.x
      const y = bounds.top + bounds.height * at.y
      const target = document.elementFromPoint(x, y)
      const page = target?.closest<HTMLElement>(".page")
      if (!target || !page) throw new Error("Expected a PDF page under the pointer")
      const before = page.getBoundingClientRect()
      const fx = (x - before.left) / before.width
      const fy = (y - before.top) / before.height
      const event = new WheelEvent("wheel", {
        ...init,
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
      })
      target.dispatchEvent(event)
      if (!event.defaultPrevented) throw new Error("Expected the viewer to zoom")
      await new Promise(requestAnimationFrame)
      const after = page.getBoundingClientRect()
      if (Math.abs(after.width - before.width) < 1) throw new Error("Expected the scale to change")
      return Math.hypot(after.left + fx * after.width - x, after.top + fy * after.height - y)
    },
    { at, init },
  )
}

/** PDF.js scale of the visible surface; its CSS --scale-factor is scale * 96 / 72. */
async function pdfScale(viewer: Locator): Promise<number> {
  return viewer
    .locator(".pi-pdf-pages:visible .pdfViewer")
    .evaluate((element) => Number(element.style.getPropertyValue("--scale-factor")) / (96 / 72))
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
    await page.getByTestId("nav-settings").click()
    await page.getByTestId("settings-nav-latex").click()
    await page.getByTestId("settings-latex-provider").selectOption("system")
    await expect(page.getByTestId("settings-latex-provider")).toHaveValue("system")
    await page.getByTestId("settings-back").click()
    await page.getByTestId("project-item").click()
    await page.getByTestId("panel-tab-files").click()
    await page.getByTestId("file-tree-dir").filter({ hasText: "build" }).click()
    await page.getByTestId("file-tree-file").filter({ hasText: "main.pdf" }).click()
    const viewer = page.getByTestId("pdf-viewer")
    await expect(viewer).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId("editor-rejected-read")).toHaveCount(0)
    await expect(viewer.locator(".page canvas").first()).toBeVisible()
    await expect(viewer.locator(".textLayer").first()).toContainText("First page")

    // The status bar shows the current page instead of a PDF toolbar.
    const pdfStatus = page.getByTestId("pdf-status")
    await expect(viewer.getByRole("toolbar")).toHaveCount(0)
    await expect(pdfStatus).toHaveText("Page 1 / 2")

    // A trackpad pinch arrives as ctrl + wheel and zooms continuously.
    const fitWidth = await pdfScale(viewer)
    expect(await wheelPdf(viewer, { ctrlKey: true, deltaY: -20 })).toBe(true)
    await expect.poll(() => pdfScale(viewer)).toBeGreaterThan(fitWidth)
    // Zooming keeps the page point under the pointer in place, for a pinch and for
    // Shift + wheel, instead of zooming towards the top-left corner.
    expect(
      await zoomDriftAt(viewer, { x: 0.7, y: 0.4 }, { ctrlKey: true, deltaY: -20 }),
    ).toBeLessThan(3)
    expect(
      await zoomDriftAt(viewer, { x: 0.6, y: 0.5 }, { shiftKey: true, deltaY: -100 }),
    ).toBeLessThan(3)
    // Zooming out near the top would need a negative scroll, so start lower on page 1.
    await viewer.locator(".pi-pdf-pages:visible").evaluate((container) => {
      container.scrollTop += container.clientHeight
    })
    expect(
      await zoomDriftAt(viewer, { x: 0.4, y: 0.6 }, { ctrlKey: true, deltaY: 20 }),
    ).toBeLessThan(3)
    // Shift + wheel steps through the presets and stops at 50%.
    for (let step = 0; step < 8; step += 1) {
      expect(await wheelPdf(viewer, { shiftKey: true, deltaY: 100 })).toBe(true)
    }
    await expect.poll(() => pdfScale(viewer)).toBeCloseTo(0.5)
    expect(await wheelPdf(viewer, { shiftKey: true, deltaY: -100 })).toBe(true)
    await expect.poll(() => pdfScale(viewer)).toBeCloseTo(0.75)
    // macOS may report a Shift + wheel in deltaX.
    expect(await wheelPdf(viewer, { shiftKey: true, deltaX: -100 })).toBe(true)
    await expect.poll(() => pdfScale(viewer)).toBeCloseTo(1)
    expect(await wheelPdf(viewer, { shiftKey: true, deltaY: -100 })).toBe(true)
    await expect.poll(() => pdfScale(viewer)).toBeCloseTo(1.25)
    // A plain wheel still scrolls.
    expect(await wheelPdf(viewer, { deltaY: 40 })).toBe(false)

    await scrollToPdfPage(viewer, 2)
    await expect(viewer.locator(".textLayer").filter({ hasText: ORIGINAL })).toBeVisible()
    await expect(pdfStatus).toHaveText("Page 2 / 2")

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
    await expect(pdfStatus).toContainText("Page 2 / 2")
    await expect.poll(() => pdfScale(viewer)).toBeCloseTo(1.25)
    const scrollAfterRefresh = await viewer
      .locator(".pi-pdf-pages:visible")
      .evaluate((element) => element.scrollTop)
    expect(Math.abs(scrollAfterRefresh - scrollBeforeRefresh)).toBeLessThan(3)

    // Reverse SyncTeX must open the included file, not merely the root document.
    const target = viewer.locator(".textLayer span").filter({ hasText: UPDATED }).first()
    await target.dblclick()
    // Splits keep every open editor mounted while hidden, so target the shown one.
    const editor = page.locator('[data-testid="editor-buffer"]:visible')
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
    await scrollToPdfPage(viewer, 1)
    await expect(pdfStatus).toContainText("Page 1 / 2")
    await page.getByTestId("central-tab-select").filter({ hasText: "chapter.tex" }).click()
    await editor.locator(".cm-line").filter({ hasText: UPDATED }).dblclick()
    await expect(viewer).toBeVisible()
    await expect(pdfStatus).toContainText("Page 2 / 2")
    await expect(viewer.locator(".textLayer").filter({ hasText: UPDATED })).toBeVisible()

    await expect(
      viewer.locator(".textLayer span").filter({ hasText: UPDATED }).first(),
    ).toBeInViewport({ ratio: 0.8 })

    // A consumed SyncTeX target must not pull the reader back to page 2 when
    // a later build refreshes the PDF while they are reading page 1.
    await scrollToPdfPage(viewer, 1)
    await expect(pdfStatus).toContainText("Page 1 / 2")
    const previousSurface = await viewer.locator(".pi-pdf-pages:visible").elementHandle()
    if (!previousSurface) throw new Error("Expected a rendered PDF surface")
    await writeFile(join(repo, "chapter.tex"), `% !TeX root = main.tex\n\n${REFRESHED_AGAIN}\n`)
    await compileFixture(repo)
    await expect(viewer.locator(".textLayer").filter({ hasText: REFRESHED_AGAIN })).toBeAttached({
      timeout: 15_000,
    })
    await expect(pdfStatus).toContainText("Page 1 / 2")
    await scrollToPdfPage(viewer, 2)
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
    await expect(pdfStatus).toContainText("Page 2 / 2")

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
    // The focused PDF shares the central panel's single status bar, which shows
    // both its page status and the workspace LaTeX build status.
    const statusBar = page.getByTestId("editor-status-bar")
    await expect(statusBar.getByTestId("pdf-status")).toContainText("Page")
    await checkBuildFooter(page.getByTestId("central-panel"), statusBar)
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
    await expect(pdfStatus).toContainText("showing previous PDF", {
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
    // Once current, the status bar shows only the page.
    await expect(pdfStatus).toHaveText(/^Page [12] \/ 2$/)
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
