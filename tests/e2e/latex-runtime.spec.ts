import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from "./fixtures/playwright"

const ORIGINAL = "Bundled compiler target in the included chapter."
const UPDATED = "Updated bundled compiler target in the included chapter."
/**
 * Tectonic cache kept between runs (inside the ignored `.cache/`), used when
 * PI_LAB_TEST_TECTONIC_CACHE is not set. Only the first run on a machine downloads the bundle.
 */
const PERSISTENT_CACHE = resolve(".cache", "tectonic-e2e")
/** A build that must first download the TeX bundle into an empty cache takes about two minutes. */
const COLD_BUILD_TIMEOUT = 180_000
const WARM_BUILD_TIMEOUT = 60_000

const MAIN = String.raw`\documentclass{article}
\begin{document}
First page from bundled Tectonic.
\newpage
\input{chapter}
\end{document}
`

/** Scroll the visible PDF surface so the given page starts at its top. */
async function scrollToPdfPage(viewer: Locator, pageNumber: number): Promise<void> {
  await viewer.locator(".pi-pdf-pages:visible").evaluate((container, target) => {
    const element = container.querySelector<HTMLElement>(`.page[data-page-number="${target}"]`)
    if (!element) throw new Error(`Expected PDF page ${target}`)
    container.scrollTop = element.offsetTop
  }, pageNumber)
}

/** Start the actual desktop build with isolated settings, projects, and TeX cache. */
async function launch(root: string, repo: string): Promise<ElectronApplication> {
  const desktop = resolve("apps/desktop")
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional packaged target for direct Playwright runs.
  const binary = process.env.PI_LAB_PACKAGED_BINARY
  return electron.launch({
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
}

/** Destroy test windows so quit confirmation cannot leave Electron running. */
async function close(app: ElectronApplication): Promise<void> {
  const process = app.process()
  const forceExit = setTimeout(() => process.kill("SIGKILL"), 5_000)
  await app
    .evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy()
    })
    .catch(() => undefined)
  await app.close().catch(() => process.kill("SIGKILL"))
  clearTimeout(forceExit)
}

/** Enter the global LaTeX settings through the actual sidebar navigation. */
async function latexSettings(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await page.getByTestId("nav-settings").click()
  await page.getByTestId("settings-nav-latex").click()
  await expect(page.getByTestId("settings-latex-provider")).toBeVisible({ timeout: 15_000 })
  return page
}

/** Save through CodeMirror so the same filesystem/compiler path used by users runs. */
async function saveChapter(
  page: Page,
  repo: string,
  text: string,
  buildTimeout: number,
): Promise<void> {
  const editor = page.getByTestId("editor-buffer")
  await expect(editor).toBeVisible()
  await editor.locator(".cm-content").click()
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.insertText(`% !TeX root = main.tex\n\n${text}\n`)
  await page.keyboard.press("ControlOrMeta+s")
  await expect.poll(() => readFile(join(repo, "chapter.tex"), "utf8")).toContain(text)
  await expect(page.locator('[data-testid="latex-build-status"]:visible')).toContainText(
    /built|complete|success/i,
    { timeout: buildTimeout },
  )
}

/** Real Electron, SQLite, IPC, bundled Tectonic, PDF.js, and SyncTeX integration. */
test("global LaTeX choice survives restart and bundled compilation refreshes and synchronizes PDFs", async () => {
  // CI runners skip the large TeX bundle download to save credits.
  test.skip(Boolean(process.env.CI), "Downloads the TeX bundle; run locally")
  test.setTimeout(180_000)
  const root = await mkdtemp(join(tmpdir(), "pi-lab-latex-runtime-e2e-"))
  const first = join(root, "first-paper")
  const second = join(root, "second-paper")
  await mkdir(first)
  await mkdir(second)
  await writeFile(join(first, "main.tex"), MAIN)
  await writeFile(join(first, "chapter.tex"), `% !TeX root = main.tex\n\nInitial chapter.\n`)
  await writeFile(join(second, "main.tex"), MAIN)
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional prewarmed TeX bundle avoids network in offline E2E runs.
  const cache = process.env.PI_LAB_TEST_TECTONIC_CACHE
  let buildTimeout = WARM_BUILD_TIMEOUT
  if (cache) await cp(cache, join(root, "latex", "cache"), { recursive: true })
  else {
    // The app's cache folder links to the persistent one, so downloads are kept for later runs.
    await mkdir(PERSISTENT_CACHE, { recursive: true })
    if ((await readdir(PERSISTENT_CACHE)).length === 0) {
      buildTimeout = COLD_BUILD_TIMEOUT
      test.setTimeout(180_000 + COLD_BUILD_TIMEOUT)
    }
    await mkdir(join(root, "latex"))
    await symlink(PERSISTENT_CACHE, join(root, "latex", "cache"), "dir")
  }
  let app: ElectronApplication | null = null
  try {
    app = await launch(root, first)
    let page = await latexSettings(app)
    const section = page.getByTestId("settings-section-latex")
    await expect(page.getByLabel("LaTeX compiler")).toHaveValue("bundled")
    await expect(section).toContainText("applies to all projects")
    await expect(section).toContainText(/tectonic.*\d/iu)
    const systemPath = section.getByText(/^PDFLaTeX:/)
    const missingSystem = (await systemPath.textContent())?.includes("Not found")
    const install = section.getByRole("button", { name: "Install PDFLaTeX" })
    if (missingSystem) await expect(install).toBeVisible()
    else await expect(install).toHaveCount(0)
    await expect(systemPath).toBeHidden()
    const details = section.locator("details").filter({ hasText: /PDFLaTeX:/ })
    await details.locator("summary").click()
    await expect(systemPath).toBeVisible()
    await details.locator("summary").click()
    await page.screenshot({ path: test.info().outputPath("latex-settings.png") })
    await page.getByTestId("settings-latex-provider").selectOption("system")
    await expect(page.getByTestId("settings-latex-provider")).toHaveValue("system")
    await close(app)
    app = null

    // A second project reads the same saved preference after a process restart.
    app = await launch(root, second)
    page = await latexSettings(app)
    await expect(page.getByTestId("settings-latex-provider")).toHaveValue("system")
    await page.getByTestId("settings-back").click()
    await expect(page.getByTestId("project-item").filter({ hasText: "second-paper" })).toBeVisible()
    await page.getByTestId("project-item").filter({ hasText: "second-paper" }).click()
    await page.getByTestId("nav-settings").click()
    await page.getByTestId("settings-nav-latex").click()
    await expect(page.getByTestId("settings-latex-provider")).toHaveValue("system")
    await page.getByTestId("settings-latex-provider").selectOption("bundled")
    await expect(page.getByTestId("settings-latex-provider")).toHaveValue("bundled")
    await close(app)
    app = null

    app = await launch(root, first)
    page = await latexSettings(app)
    await expect(page.getByTestId("settings-latex-provider")).toHaveValue("bundled")
    await page.getByTestId("settings-back").click()
    await page.getByTestId("project-item").filter({ hasText: "first-paper" }).click()
    await page.getByTestId("panel-tab-files").click()
    await page.getByTestId("file-tree-file").filter({ hasText: "chapter.tex" }).click()
    await saveChapter(page, first, ORIGINAL, buildTimeout)
    await expect
      .poll(() =>
        readFile(join(first, "build", "main.pdf")).then((bytes) => bytes.subarray(0, 4).toString()),
      )
      .toBe("%PDF")
    await expect
      .poll(() => readFile(join(first, "build", "main.synctex.gz")).then((bytes) => bytes.length))
      .toBeGreaterThan(0)
    await page.getByTestId("latex-build-status").click()
    await expect(page.getByTestId("latex-build-log")).toContainText(/tectonic|Running TeX/iu)
    await page.getByTestId("latex-build-status").click()
    await page.getByTestId("latex-show-pdf").click()
    const viewer = page.getByTestId("pdf-viewer")
    const pdfStatus = page.getByTestId("pdf-status")
    await expect(viewer).toBeVisible()
    // Show in PDF opens the PDF at the chapter's position, which is on page two.
    await expect(pdfStatus).toContainText("Page 2 / 2", { timeout: 15_000 })
    const target = viewer.locator(".textLayer span").filter({ hasText: ORIGINAL }).first()
    await expect(target).toBeInViewport({ ratio: 0.8, timeout: 15_000 })

    // Reverse synchronization opens the included file and selects the mapped line.
    await target.dblclick()
    // chapter.tex is already open, but hidden behind the PDF, until the reverse sync shows it.
    const editor = page.locator('[data-testid="editor-buffer"]:visible')
    await expect(editor).toContainText(ORIGINAL)
    await expect(
      page.getByTestId("central-tab-select").filter({ hasText: "chapter.tex" }),
    ).toBeVisible()
    await expect
      .poll(() =>
        editor.locator(".cm-content").evaluate((element) => {
          const anchor = window.getSelection()?.anchorNode
          return element.contains(anchor ?? null)
            ? anchor?.parentElement?.closest(".cm-line")?.textContent
            : null
        }),
      )
      .toContain(ORIGINAL)

    // Forward synchronization must navigate from page one to page two.
    await page.getByTestId("central-tab-select").filter({ hasText: "main.pdf" }).click()
    await scrollToPdfPage(viewer, 1)
    await expect(pdfStatus).toContainText("Page 1 / 2")
    await page.getByTestId("central-tab-select").filter({ hasText: "chapter.tex" }).click()
    await editor.locator(".cm-line").filter({ hasText: ORIGINAL }).dblclick()
    await expect(viewer).toBeVisible()
    await expect(pdfStatus).toContainText("Page 2 / 2")
    await expect(target).toBeInViewport({ ratio: 0.8 })

    // The next save recompiles and updates the already open PDF without reopening its file.
    await page.getByTestId("central-tab-select").filter({ hasText: "chapter.tex" }).click()
    await saveChapter(page, first, UPDATED, WARM_BUILD_TIMEOUT)
    await page.getByTestId("central-tab-select").filter({ hasText: "main.pdf" }).click()
    await expect(
      viewer.locator(".textLayer span").filter({ hasText: UPDATED }).first(),
    ).toBeInViewport({ ratio: 0.8, timeout: 15_000 })
    // Once current, the status bar shows only the page.
    await expect(pdfStatus).toHaveText(/^Page [12] \/ 2$/)
    await page.screenshot({ path: test.info().outputPath("bundled-latex.png") })
  } finally {
    if (app) await close(app)
    await rm(root, { recursive: true, force: true })
  }
})
