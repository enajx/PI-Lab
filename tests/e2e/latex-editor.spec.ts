import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "./fixtures/playwright"

const execFileAsync = promisify(execFile)

/** Run git in a folder with a fixed identity so commits work on any machine. */
async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "-C",
    dir,
    "-c",
    "user.name=PI Lab Test",
    "-c",
    "user.email=test@example.invalid",
    ...args,
  ])
  return stdout
}

const MAIN = String.raw`\documentclass{article}
\begin{document}
\section{Introduction}
Shared first line.
\section{Method}
Method text.
\end{document}
`

/** Tectonic cache shared with latex-runtime.spec.ts (inside the ignored `.cache/`). */
const PERSISTENT_CACHE = resolve(".cache", "tectonic-e2e")

/**
 * The "Overleaf" remote here is a LOCAL bare Git repository (a stand-in: no
 * network, no Overleaf account). The paper is linked with "Use an existing
 * folder", so the real app, IPC, SQLite and system `git` run unchanged. The
 * Overleaf URL check and token handling are covered by the `paper` router tests.
 */
async function setUp(root: string): Promise<{ project: string; paper: string; overleaf: string }> {
  const remote = join(root, "remote.git")
  const seed = join(root, "seed")
  const project = join(root, "project")
  const paper = join(root, "papers", "my-paper")
  const overleaf = join(root, "overleaf-side")
  await mkdir(project)
  await mkdir(join(root, "papers"))
  await execFileAsync("git", ["init", "--bare", "-b", "master", remote])
  await execFileAsync("git", ["clone", remote, seed])
  await writeFile(join(seed, "main.tex"), MAIN)
  await git(seed, "add", "main.tex")
  await git(seed, "commit", "-m", "Initial paper")
  await git(seed, "push", "origin", "HEAD:master")
  await execFileAsync("git", ["clone", remote, paper])
  await execFileAsync("git", ["clone", remote, overleaf])
  return { project, paper, overleaf }
}

/**
 * Start the real desktop build with isolated data (in `<root>/data`), the
 * project open, and a fixed folder picker. `extraEnv` is added to the app's
 * environment.
 */
async function launch(
  root: string,
  project: string,
  pickDir: string,
  extraEnv: Record<string, string>,
): Promise<ElectronApplication> {
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
      // Its own folder: a packaged Alpha app empties its data folder when it starts a new
      // build, which would delete the test's project and paper folders kept in `root`.
      PI_LAB_DATA_DIR: join(root, "data"),
      PI_LAB_SOCKET_PATH: join(root, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: project,
      PI_LAB_TEST_PICK_DIRECTORY: pickDir,
      PI_LAB_TEST_AGENT_ID: "test-echo",
      ...extraEnv,
    },
  })
}

/** Destroy test windows so quit confirmation cannot leave Electron running. */
async function close(app: ElectronApplication): Promise<void> {
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

/** Open LaTeX Editor from the project's dashboard card. */
async function openLatexEditor(page: Page): Promise<void> {
  await page.getByTestId("nav-dashboard").click()
  await page.getByTestId("project-card").getByTestId("project-card-latex").click()
  await expect(page.getByTestId("science-latex")).toBeVisible()
}

/**
 * Choose the project's agent (a deterministic test agent), open LaTeX Editor
 * from the project's dashboard card and link the paper folder. The setup shows
 * its three options side by side first.
 */
async function openAndLink(page: Page, agentId: string): Promise<void> {
  await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await page.getByTestId("nav-dashboard").click()
  await page
    .getByTestId("project-card")
    .getByTestId("project-card-body")
    .click({ button: "right", position: { x: 24, y: 24 } })
  await page.getByTestId("project-card-menu-edit").click()
  await page.getByTestId("edit-project-agent").selectOption(agentId)
  await page.getByTestId("edit-project-save").click()
  await page.getByTestId("project-card").getByTestId("project-card-latex").click()
  await expect(page.getByTestId("science-latex")).toBeVisible()
  await expect(page.getByTestId("latex-project-select")).toHaveAttribute("value", /.+/)
  await expectSetupCards(page)
  await page.screenshot({ path: test.info().outputPath("latex-setup.png") })
  // No Sync button before a paper is linked.
  await expect(page.getByTestId("paper-sync")).toHaveCount(0)
  await page.getByTestId("paper-use-folder").click()
  await expect(page.getByTestId("paper-editor")).toBeVisible({ timeout: 15_000 })
}

/** The setup cards, left to right. */
const SETUP_CARDS = ["paper-setup-overleaf", "paper-setup-folder", "paper-setup-create"]

/**
 * The token status loads after the cards appear and can change their height
 * for a moment, so wait for the settled layout: three equal cards side by side
 * on one row, laid out like the Library's source chooser (see {@link expectCentredSetup}).
 */
async function expectSetupCards(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      const boxes = await Promise.all(SETUP_CARDS.map((id) => page.getByTestId(id).boundingBox()))
      for (const [index, box] of boxes.entries()) {
        const previous = index > 0 ? boxes[index - 1] : null
        if (!box || (index > 0 && !previous)) return "setup options are not visible"
        if (!previous) continue
        if (box.x < previous.x + previous.width) return "cards are not side by side"
        if (Math.abs(box.y - previous.y) >= 1) return `cards are ${box.y - previous.y}px apart`
        if (Math.abs(box.width - previous.width) >= 1) return "cards differ in width"
        if (Math.abs(box.height - previous.height) >= 1) return "cards differ in height"
      }
      return "ok"
    })
    .toBe("ok")
  await expect(() => expectCentredSetup(page)).toPass({ timeout: 5_000 })
  await page.screenshot({ path: resolve(".cache", "screens", "latex-setup-cards.png") })
}

/** The bottom-right button of each setup card, in the order of {@link SETUP_CARDS}. */
const SETUP_BUTTONS = ["paper-overleaf-add", "paper-use-folder", "paper-create"]

/**
 * The setup page is laid out like the Library's source chooser: a heading above
 * three cards in a row, horizontally centred with at least 24px on both sides at
 * the default window size, with gaps between the cards, 16px of padding inside
 * each card above its title and below its button, and nothing in a card cut or
 * reaching past its edges (long text wraps).
 */
async function expectCentredSetup(page: Page): Promise<void> {
  const cards = await Promise.all(SETUP_CARDS.map((id) => page.getByTestId(id).boundingBox()))
  const buttons = await Promise.all(SETUP_BUTTONS.map((id) => page.getByTestId(id).boundingBox()))
  const area = await page.getByTestId("paper-setup").boundingBox()
  const heading = await page
    .getByTestId("paper-setup-content")
    .getByRole("heading", { level: 2 })
    .boundingBox()
  const [overleaf, folder, create] = cards
  if (!overleaf || !folder || !create || !area || !heading || buttons.some((box) => !box)) {
    throw new Error("setup layout is not visible")
  }
  // The heading sits above the cards, with space between it and the top bar.
  expect(heading.y - area.y).toBeGreaterThanOrEqual(24)
  expect(heading.y + heading.height).toBeLessThanOrEqual(overleaf.y)
  // Clear margins on both sides of the row, and the row is centred.
  expect(overleaf.x - area.x).toBeGreaterThanOrEqual(24)
  expect(area.x + area.width - (create.x + create.width)).toBeGreaterThanOrEqual(24)
  const row = { left: overleaf.x, right: create.x + create.width }
  expect(Math.abs((row.left + row.right) / 2 - (area.x + area.width / 2))).toBeLessThan(2)
  // The cards do not touch.
  for (const [left, right] of [
    [overleaf, folder],
    [folder, create],
  ]) {
    expect(right.x - (left.x + left.width)).toBeGreaterThanOrEqual(8)
  }
  // 16px of padding above each card's content and below its button.
  for (const [index, card] of cards.entries()) {
    const button = buttons[index]
    if (!card || !button) throw new Error("setup layout is not visible")
    expect(Math.abs(card.y + card.height - (button.y + button.height) - 16)).toBeLessThan(2)
  }
  // Nothing in a card is cut (no element scrolls its own text) or reaches past the card's padding.
  const problems = await page.evaluate((ids) => {
    const found: string[] = []
    for (const id of ids) {
      const card = document.querySelector(`[data-testid="${id}"]`) as HTMLElement
      const box = card.getBoundingClientRect()
      if (box.top + 15 > (card.firstElementChild as HTMLElement).getBoundingClientRect().top) {
        found.push(`${id}: less than 16px above its content`)
      }
      for (const element of [card, ...card.querySelectorAll<HTMLElement>("*")]) {
        if (element instanceof SVGElement || element.tagName === "INPUT") continue
        const inner = element.getBoundingClientRect()
        if (element.scrollWidth > element.clientWidth + 1) {
          found.push(`${id}: "${element.textContent}" is cut`)
        }
        if (inner.left < box.left + 15 && element !== card) found.push(`${id}: past the left edge`)
        if (inner.right > box.right - 15 && element !== card) {
          found.push(`${id}: "${element.textContent}" reaches past the right edge`)
        }
      }
    }
    return found
  }, SETUP_CARDS)
  expect(problems).toEqual([])
}

/** Replace the line under \section{Introduction} (the line both sides edit). */
function withFirstLine(text: string, line: string): string {
  return text.replace(/(\\section\{Introduction\}\n).*\n/, `$1${line}\n`)
}

/** Commit a new first body line on the "Overleaf" side and push it. */
async function overleafEdit(overleaf: string, line: string): Promise<void> {
  await git(overleaf, "pull", "--no-rebase", "--no-edit")
  const current = await readFile(join(overleaf, "main.tex"), "utf8")
  await writeFile(join(overleaf, "main.tex"), withFirstLine(current, line))
  await git(overleaf, "commit", "-am", `Overleaf: ${line}`)
  await git(overleaf, "push", "origin", "HEAD:master")
}

/** Start a conflict: Overleaf and the local paper both change the same line. */
async function makeConflict(paper: string, overleaf: string, tag: string): Promise<void> {
  await overleafEdit(overleaf, `Overleaf ${tag}.`)
  const local = await readFile(join(paper, "main.tex"), "utf8")
  await writeFile(join(paper, "main.tex"), withFirstLine(local, `Local ${tag}.`))
}

test("LaTeX Editor links a paper, shows its outline and files, and syncs and resolves conflicts", async () => {
  test.setTimeout(180_000)
  const root = await mkdtemp(join(tmpdir(), "pi-lab-latex-editor-e2e-"))
  const { project, paper, overleaf } = await setUp(root)
  let app: ElectronApplication | null = null
  try {
    app = await launch(root, project, paper, {})
    const page = await app.firstWindow()
    // Background agent work (Ask agent to merge) uses the deterministic test merge agent.
    await openAndLink(page, "test-merge")
    await page.screenshot({ path: test.info().outputPath("latex-editor.png") })

    // The editor's left column: hidden by default. Once opened, Files and the
    // Outline below it are both expanded, and the main .tex is open with LaTeX colouring.
    const column = page.getByTestId("central-files-panel")
    const filesHeader = page.getByTestId("central-files-section")
    const outlineHeader = page.getByTestId("paper-outline-section")
    await expect(column).toHaveCount(0)
    await page.getByTestId("central-files-toggle").click()
    await expect(page.getByTestId("paper-outline-entry")).toHaveText(["Introduction", "Method"])
    await expect(filesHeader).toHaveAttribute("aria-expanded", "true")
    await expect(outlineHeader).toHaveAttribute("aria-expanded", "true")
    await expect(column.getByTestId("file-tree-file").filter({ hasText: "main.tex" })).toBeVisible()
    const filesBox = await filesHeader.boundingBox()
    const outlineBox = await outlineHeader.boundingBox()
    if (!filesBox || !outlineBox) throw new Error("left column sections are not visible")
    expect(outlineBox.y).toBeGreaterThan(filesBox.y)
    // The panel button hides and shows the column.
    await page.getByTestId("central-files-toggle").click()
    await expect(column).toHaveCount(0)
    await page.getByTestId("central-files-toggle").click()
    await expect(column.getByTestId("paper-outline")).toBeVisible()
    // Outline and Files collapse, and stay collapsed after a reload.
    await outlineHeader.click()
    await filesHeader.click()
    await expect(column.getByTestId("paper-outline")).toHaveCount(0)
    await expect(column.getByTestId("panel-files")).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId("nav-dashboard")).toBeVisible({ timeout: 30_000 })
    await openLatexEditor(page)
    await expect(outlineHeader).toHaveAttribute("aria-expanded", "false")
    await expect(filesHeader).toHaveAttribute("aria-expanded", "false")
    await expect(column.getByTestId("panel-files")).toHaveCount(0)
    await outlineHeader.click()
    await filesHeader.click()
    await expect(column.getByTestId("panel-files")).toBeVisible()
    // The Sync button is in the page top bar, next to the project picker.
    const topBar = page.getByTestId("science-latex").locator("header")
    await expect(topBar.getByTestId("paper-sync")).toBeVisible()
    await expect(topBar.getByTestId("latex-project-select")).toBeVisible()
    const editor = page.getByTestId("central-panel").getByTestId("editor-buffer")
    await expect(editor.locator(".cm-content")).toContainText("Shared first line.")
    await expect(editor.locator(".cm-line span").first()).toBeVisible()
    await page.getByTestId("paper-outline-entry").filter({ hasText: "Method" }).click()

    // Sync asks before committing edits not yet sent; "Don't ask again" sticks.
    await writeFile(join(paper, "main.tex"), MAIN.replace("Method text.", "Local method text."))
    await page.getByTestId("paper-sync").click()
    await expect(page.getByTestId("paper-commit-dialog")).toContainText("main.tex")
    await page.getByTestId("paper-commit-dont-ask").check()
    await page.getByTestId("paper-commit-confirm").click()
    await expect(page.getByTestId("editor-status-bar").getByTestId("paper-last-sync")).toHaveText(
      "Synced just now",
      {
        timeout: 15_000,
      },
    )
    await git(overleaf, "pull", "--no-rebase", "--no-edit")
    expect(await readFile(join(overleaf, "main.tex"), "utf8")).toContain("Local method text.")

    // Conflict: Cancel leaves it; Sync again shows it; Open in editor opens the file.
    await makeConflict(paper, overleaf, "one")
    await page.getByTestId("paper-sync").click()
    await expect(page.getByTestId("paper-commit-dialog")).toHaveCount(0)
    await expect(page.getByTestId("paper-conflict-dialog")).toContainText("main.tex", {
      timeout: 15_000,
    })
    await page.getByTestId("paper-conflict-cancel").click()
    await expect(page.getByTestId("paper-conflict-dialog")).toHaveCount(0)
    expect(await readFile(join(paper, "main.tex"), "utf8")).toContain("<<<<<<< ")
    await page.getByTestId("paper-sync").click()
    await expect(page.getByTestId("paper-conflict-dialog")).toBeVisible({ timeout: 15_000 })
    await page.getByTestId("paper-conflict-editor").click()
    await expect(editor.locator(".cm-content")).toContainText("<<<<<<<")

    // Keep Overleaf version resolves and pushes.
    await page.getByTestId("paper-sync").click()
    await page.getByTestId("paper-conflict-overleaf").click()
    await expect(page.getByTestId("paper-conflict-dialog")).toHaveCount(0, { timeout: 15_000 })
    const kept = await readFile(join(paper, "main.tex"), "utf8")
    expect(kept).toContain("Overleaf one.")
    expect(kept).not.toContain("<<<<<<<")
    // Keep my version resolves and pushes the local line.
    await makeConflict(paper, overleaf, "two")
    await page.getByTestId("paper-sync").click()
    await page.getByTestId("paper-conflict-mine").click()
    await expect(page.getByTestId("paper-conflict-dialog")).toHaveCount(0, { timeout: 15_000 })
    await git(overleaf, "pull", "--no-rebase", "--no-edit")
    expect(await readFile(join(overleaf, "main.tex"), "utf8")).toContain("Local two.")

    // Ask agent to merge: the test merge agent keeps both sides; Reject restores
    // the conflict, and Accept pushes the reviewed merge.
    await makeConflict(paper, overleaf, "three")
    await page.getByTestId("paper-sync").click()
    await page.getByTestId("paper-conflict-agent").click()
    const review = page.getByTestId("paper-agent-merge")
    await expect(page.getByTestId("paper-agent-merge-accept")).toBeEnabled({ timeout: 30_000 })
    await expect(review).toContainText("Local three.")
    await expect(review).toContainText("Overleaf three.")
    await page.getByTestId("paper-agent-merge-reject").click()
    await expect(page.getByTestId("paper-conflict-dialog")).toBeVisible({ timeout: 15_000 })
    expect(await readFile(join(paper, "main.tex"), "utf8")).toContain("<<<<<<< ")
    await page.getByTestId("paper-conflict-agent").click()
    await expect(page.getByTestId("paper-agent-merge-accept")).toBeEnabled({ timeout: 30_000 })
    await page.getByTestId("paper-agent-merge-accept").click()
    await expect(page.getByTestId("paper-agent-merge")).toHaveCount(0, { timeout: 15_000 })
    await git(overleaf, "pull", "--no-rebase", "--no-edit")
    const merged = await readFile(join(overleaf, "main.tex"), "utf8")
    expect(merged).toContain("Local three.\nOverleaf three.")
    expect(merged).not.toContain("<<<<<<<")
  } finally {
    if (app) await close(app)
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * Real build through bundled Tectonic into a per-paper output folder: Cmd+S
 * opens the PDF beside the source, a later save refreshes it, and Sync does not
 * send the output folder.
 */
test("LaTeX Editor builds the paper and shows the PDF beside the source", async () => {
  // CI runners skip the large TeX bundle download to save credits.
  test.skip(Boolean(process.env.CI), "Downloads the TeX bundle; run locally")
  test.setTimeout(300_000)
  const root = await mkdtemp(join(tmpdir(), "pi-lab-latex-editor-build-e2e-"))
  const { project, paper, overleaf } = await setUp(root)
  await mkdir(PERSISTENT_CACHE, { recursive: true })
  await mkdir(join(root, "data", "latex"), { recursive: true })
  await symlink(PERSISTENT_CACHE, join(root, "data", "latex", "cache"), "dir")
  let app: ElectronApplication | null = null
  try {
    app = await launch(root, project, paper, {})
    const page = await app.firstWindow()
    // Background agent work (Ask agent to merge) uses the deterministic test merge agent.
    await openAndLink(page, "test-merge")
    // The linked paper has no PDF yet, so it is built on open (into the default build/)
    // and shown beside the source.
    const builtOnOpen = page.locator('[data-testid="pdf-viewer"]:visible')
    await expect(builtOnOpen.locator(".page canvas").first()).toBeVisible({ timeout: 200_000 })
    expect(existsSync(join(paper, "build", "main.pdf"))).toBe(true)

    // This paper builds into its own folder.
    // The output folder is set from the editor footer's popover.
    const footer = page.getByTestId("editor-status-bar")
    const outputItem = footer.getByTestId("paper-output-folder")
    await expect(outputItem).toHaveText("Output: build")
    await outputItem.click()
    const outputField = footer.getByTestId("paper-output-dir")
    await expect(outputField).toHaveAttribute("placeholder", "build")
    await outputField.fill("pdfout")
    await outputField.press("Enter")
    await expect(outputField).toHaveCount(0)
    await expect(outputItem).toHaveText("Output: pdfout")
    await expect(footer.getByRole("alert")).toHaveCount(0)

    // Cmd+S builds and opens the PDF beside the source, without Show in PDF.
    const editor = page.getByTestId("central-panel").getByTestId("editor-buffer")
    await editor.locator(".cm-content").click()
    await page.keyboard.press("ControlOrMeta+s")
    // The status already says complete from the build on open, so wait for the new PDF first.
    await expect
      .poll(() => existsSync(join(paper, "pdfout", "main.pdf")), { timeout: 200_000 })
      .toBe(true)
    await expect(page.locator('[data-testid="latex-build-status"]:visible')).toContainText(
      /complete/i,
      { timeout: 200_000 },
    )
    // The new PDF replaces the build/ one beside the source: one PDF, the current one.
    await expect(page.getByTestId("central-tab").filter({ hasText: "main.pdf" })).toHaveCount(1)
    await expect(page.getByTestId("pdf-viewer")).toHaveCount(1)
    const viewer = page.getByTestId("pdf-viewer")
    await expect(viewer.locator(".page canvas").first()).toBeVisible({ timeout: 15_000 })
    const source = await editor.boundingBox()
    const pdf = await viewer.boundingBox()
    expect(source && pdf && pdf.x > source.x + source.width / 2).toBe(true)

    // A later save rebuilds, and the open PDF shows the new text.
    await editor.getByText("Method text.").click()
    await page.keyboard.press("End")
    await page.keyboard.type(" Zyxrefresh")
    await page.keyboard.press("ControlOrMeta+s")
    await expect(viewer).toContainText("Zyxrefresh", { timeout: 120_000 })
    await expect(page.getByTestId("pdf-viewer")).toHaveCount(1)
    await expect(page.getByTestId("central-tab").filter({ hasText: "main.pdf" })).toHaveCount(1)

    // Sync sends the edit but not the build output.
    await page.getByTestId("paper-sync").click()
    const dialog = page.getByTestId("paper-commit-dialog")
    await expect(dialog).toContainText("main.tex")
    await expect(dialog).not.toContainText("pdfout")
    await page.getByTestId("paper-commit-confirm").click()
    await expect(page.getByTestId("paper-last-sync")).toHaveText("Synced just now", {
      timeout: 15_000,
    })
    await git(overleaf, "pull", "--no-rebase", "--no-edit")
    expect(await readFile(join(overleaf, "main.tex"), "utf8")).toContain("Zyxrefresh")
    expect((await git(overleaf, "ls-files")).split("\n")).toEqual(["main.tex", ""])
  } finally {
    if (app) await close(app)
    await rm(root, { recursive: true, force: true })
  }
})

test("LaTeX Editor agents stay in the LaTeX Editor and show in the Project view's Project Agents box", async () => {
  test.setTimeout(120_000)
  const root = await mkdtemp(join(tmpdir(), "pi-lab-latex-agents-e2e-"))
  const { project, paper } = await setUp(root)
  let app: ElectronApplication | null = null
  try {
    app = await launch(root, project, paper, {})
    const page = await app.firstWindow()
    // test-activity keeps printing, so it stays a live, working agent (no real agent CLI).
    await openAndLink(page, "test-activity")
    const agentTab = page.locator('[data-testid="central-tab"][data-tab-kind="agent"]')
    await expect(agentTab).toHaveCount(0)
    await page.getByTestId("central-new-agent").click()
    await expect(agentTab).toHaveCount(1, { timeout: 15_000 })
    await expect(agentTab).toContainText("Test Activity")

    // The Project view does not show it as a tab, but lists it in Project Agents.
    await page.getByTestId("project-item").click()
    await expect(page.getByTestId("project-view")).toBeVisible()
    const box = page.getByTestId("project-agents-box")
    const row = box.locator('[data-testid="project-agent-row"][data-origin="latex"]')
    await expect(row).toContainText("Test Activity", { timeout: 15_000 })
    await expect(row).toContainText("working")
    await expect(row.getByTestId("latex-logo")).toBeVisible()
    await expect(agentTab).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath("project-agents-box.png") })

    // Clicking the row opens the LaTeX Editor with the agent's tab focused.
    await row.click()
    await expect(page.getByTestId("paper-editor")).toBeVisible()
    await expect(agentTab).toHaveCount(1)
    await expect(agentTab).toHaveAttribute("data-active", "true")

    // Leaving the LaTeX Editor and coming back keeps the agent tab.
    await page.getByTestId("nav-dashboard").click()
    await expect(page.getByTestId("science-latex")).toHaveCount(0)
    await openLatexEditor(page)
    await expect(page.getByTestId("paper-editor")).toBeVisible()
    await expect(agentTab).toHaveCount(1)
    await expect(agentTab).toContainText("Test Activity")
  } finally {
    if (app) await close(app)
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * A project whose folder IS an Overleaf clone opens straight into the editor.
 * The clone's `origin` is written as an Overleaf URL (that is what PI Lab's
 * detection reads), and a `url.<local bare repo>.insteadOf` rule makes git
 * itself fetch and push to the LOCAL bare repo (a stand-in: no network, no
 * Overleaf account). So detection sees Overleaf while Sync talks to the local
 * repo.
 */
test("LaTeX Editor links a project folder that is an Overleaf clone without the setup", async () => {
  test.setTimeout(120_000)
  const root = await mkdtemp(join(tmpdir(), "pi-lab-latex-overleaf-project-e2e-"))
  const { overleaf } = await setUp(root)
  const project = join(root, "overleaf-project")
  const overleafUrl = "https://git@git.overleaf.com/0123456789abcdef01234567"
  await execFileAsync("git", ["clone", join(root, "remote.git"), project])
  await git(project, "remote", "set-url", "origin", overleafUrl)
  await git(project, "config", `url.${join(root, "remote.git")}.insteadOf`, overleafUrl)
  let app: ElectronApplication | null = null
  try {
    app = await launch(root, project, project, {})
    const page = await app.firstWindow()
    await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await openLatexEditor(page)
    await expect(page.getByTestId("paper-editor")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("paper-setup-overleaf")).toHaveCount(0)
    await page.getByTestId("central-files-toggle").click()
    await expect(page.getByTestId("paper-outline-entry")).toHaveText(["Introduction", "Method"])
    // Sync is on: an edit is committed and pushed (to the local stand-in repo).
    await writeFile(join(project, "main.tex"), MAIN.replace("Method text.", "Root method text."))
    await page.getByTestId("paper-sync").click()
    const dialog = page.getByTestId("paper-commit-dialog")
    await expect(dialog).toContainText("main.tex")
    await page.getByTestId("paper-commit-confirm").click()
    await expect(page.getByTestId("paper-last-sync")).toHaveText("Synced just now", {
      timeout: 15_000,
    })
    await git(overleaf, "pull", "--no-rebase", "--no-edit")
    expect(await readFile(join(overleaf, "main.tex"), "utf8")).toContain("Root method text.")
  } finally {
    if (app) await close(app)
    await rm(root, { recursive: true, force: true })
  }
})

test("LaTeX Editor asks before using a project folder that is not an Overleaf clone", async () => {
  test.setTimeout(120_000)
  const root = await mkdtemp(join(tmpdir(), "pi-lab-latex-root-folder-e2e-"))
  const project = join(root, "project")
  await mkdir(project)
  await execFileAsync("git", ["init", "-b", "main", project])
  await writeFile(join(project, "main.tex"), MAIN)
  await git(project, "add", "main.tex")
  await git(project, "commit", "-m", "Project")
  // Never contacted: the paper is linked with Sync off.
  await git(
    project,
    "remote",
    "add",
    "origin",
    "https://user:secret@github.com/example/project.git",
  )
  let app: ElectronApplication | null = null
  try {
    app = await launch(root, project, project, {})
    const page = await app.firstWindow()
    await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await openLatexEditor(page)
    await page.getByTestId("paper-use-folder").click()
    const dialog = page.getByTestId("paper-root-dialog")
    await expect(dialog).toContainText("https://github.com/example/project.git")
    await expect(dialog).not.toContainText("secret")
    await page.screenshot({ path: test.info().outputPath("latex-root-dialog.png") })
    // Choose another folder opens the picker again (the test picker returns the same folder).
    await page.getByTestId("paper-root-other").click()
    await expect(dialog).toBeVisible()
    await page.getByTestId("paper-root-no-sync").click()
    await expect(page.getByTestId("paper-editor")).toBeVisible({ timeout: 15_000 })
    const topBar = page.getByTestId("science-latex").locator("header")
    await expect(topBar.getByTestId("paper-sync-off")).toHaveText("Sync is off for this paper")
    await expect(page.getByTestId("paper-last-sync")).toHaveCount(0)
    await expect(page.getByTestId("paper-sync")).toHaveCount(0)
    await page.getByTestId("central-files-toggle").click()
    await expect(page.getByTestId("paper-outline-entry")).toHaveText(["Introduction", "Method"])
  } finally {
    if (app) await close(app)
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * The paper folder can be changed and cleared from the LaTeX Editor footer and
 * set from Edit project. The project holds an Overleaf clone at `paper/` (its
 * `origin` is an Overleaf URL; nothing is fetched), which auto-detection uses
 * on the first visit. The test folder picker always returns a clone OUTSIDE
 * the project (`papers/my-paper`).
 */
test("LaTeX Editor changes and clears the paper folder from the footer, and Edit project sets it", async () => {
  test.setTimeout(120_000)
  const root = await mkdtemp(join(tmpdir(), "pi-lab-latex-paper-folder-e2e-"))
  const { project, paper } = await setUp(root)
  const detected = join(project, "paper")
  await execFileAsync("git", ["clone", join(root, "remote.git"), detected])
  await git(detected, "remote", "set-url", "origin", "https://git@git.overleaf.com/0123abcd")
  const outside = await realpath(paper)
  let app: ElectronApplication | null = null
  try {
    app = await launch(root, project, paper, {})
    const page = await app.firstWindow()
    await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await openLatexEditor(page)
    // Auto-detection uses the clone inside the project; the footer shows it relative to the project.
    await expect(page.getByTestId("paper-editor")).toBeVisible({ timeout: 15_000 })
    const item = page.getByTestId("editor-status-bar").getByTestId("editor-paper-folder")
    await expect(item).toHaveText("paper")

    // Footer: Choose paper folder… uses the picked folder outside the project (full path).
    await item.click()
    await page
      .getByRole("menu", { name: "Paper folder" })
      .getByTestId("paper-folder-choose")
      .click()
    await expect(item).toHaveText(outside, { timeout: 15_000 })
    await page.getByTestId("central-files-toggle").click()
    await expect(page.getByTestId("paper-outline-entry")).toHaveText(["Introduction", "Method"])
    await page.screenshot({ path: test.info().outputPath("latex-paper-folder-footer.png") })

    // Footer: Clear paper folder shows the setup page; the detected clone is not used again.
    await item.click()
    await page.getByTestId("paper-folder-clear").click()
    await expect(page.getByTestId("paper-setup-overleaf")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("paper-use-folder")).toHaveText("Open folder…")
    await expect(page.getByTestId("paper-detecting")).toHaveCount(0)
    await page.waitForTimeout(1_000)
    await expect(page.getByTestId("paper-editor")).toHaveCount(0)
    expect(existsSync(join(outside, "main.tex"))).toBe(true)
    expect(existsSync(join(detected, "main.tex"))).toBe(true)

    // Edit project: the row shows None, Choose… picks the folder, and Save applies it.
    await page.getByTestId("nav-dashboard").click()
    await page
      .getByTestId("project-card")
      .getByTestId("project-card-body")
      .click({ button: "right", position: { x: 24, y: 24 } })
    await page.getByTestId("project-card-menu-edit").click()
    await expect(page.getByTestId("edit-project-paper-folder")).toHaveText("None")
    await expect(page.getByTestId("edit-project-paper-clear")).toHaveCount(0)
    await page.getByTestId("edit-project-paper-choose").click()
    await expect(page.getByTestId("edit-project-paper-folder")).toHaveText(outside)
    // A long path is cut short; the buttons and the other fields stay inside the dialog.
    const dialogBox = await page.getByTestId("edit-project-dialog").boundingBox()
    const chooseBox = await page.getByTestId("edit-project-paper-choose").boundingBox()
    const nameBox = await page.getByTestId("edit-project-name").boundingBox()
    if (!dialogBox || !chooseBox || !nameBox) throw new Error("Edit project dialog is not visible")
    expect(chooseBox.x + chooseBox.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width)
    expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width)
    await page.screenshot({ path: test.info().outputPath("latex-paper-folder-edit-project.png") })
    await page.getByTestId("edit-project-save").click()
    await expect(page.getByTestId("edit-project-dialog")).toHaveCount(0)
    await page.getByTestId("project-card").getByTestId("project-card-latex").click()
    await expect(page.getByTestId("paper-editor")).toBeVisible({ timeout: 15_000 })
    await expect(
      page.getByTestId("editor-status-bar").getByTestId("editor-paper-folder"),
    ).toHaveText(outside)
  } finally {
    if (app) await close(app)
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * Choosing a folder that is not a paper (here the parent folder holding two
 * paper clones) never saves it: a dialog lists the papers inside it, and the
 * one chosen there is used. `papers/second` is an Overleaf clone (its
 * `origin` is an Overleaf URL; nothing is fetched).
 */
test("LaTeX Editor lists the papers inside a chosen folder that is not a paper", async () => {
  test.setTimeout(120_000)
  const root = await mkdtemp(join(tmpdir(), "pi-lab-latex-not-paper-e2e-"))
  const { project } = await setUp(root)
  const parent = join(root, "papers")
  const second = join(parent, "second")
  await execFileAsync("git", ["clone", join(root, "remote.git"), second])
  await git(second, "remote", "set-url", "origin", "https://git@git.overleaf.com/0123abcd")
  let app: ElectronApplication | null = null
  try {
    app = await launch(root, project, parent, {})
    const page = await app.firstWindow()
    await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await openLatexEditor(page)
    await page.getByTestId("paper-use-folder").click()
    const dialog = page.getByTestId("paper-not-paper-dialog")
    await expect(dialog).toContainText("This folder is not a paper folder. Papers found inside it:")
    const options = dialog.getByTestId("paper-inside-option")
    await expect(options).toHaveText(["my-paper", "secondOverleaf"])
    await page.screenshot({ path: test.info().outputPath("latex-not-paper-dialog.png") })
    await expect(page.getByTestId("paper-editor")).toHaveCount(0)
    await options.nth(1).click()
    await expect(page.getByTestId("paper-editor")).toBeVisible({ timeout: 15_000 })
    await expect(
      page.getByTestId("editor-status-bar").getByTestId("editor-paper-folder"),
    ).toHaveText(await realpath(second))
    await page.getByTestId("central-files-toggle").click()
    await expect(page.getByTestId("paper-outline-entry")).toHaveText(["Introduction", "Method"])
  } finally {
    if (app) await close(app)
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * Start draft when `<project>/paper/` already has files: the card proposes
 * `paper-2/` and can start right away, and choosing a folder with files in it
 * (the fixed folder picker returns `paper/`) says why it cannot be used.
 */
test("LaTeX Editor Start draft proposes paper-2/ when paper/ has files", async () => {
  test.setTimeout(120_000)
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-lab-latex-draft-e2e-")))
  const project = join(root, "project")
  const existing = join(project, "paper")
  await mkdir(existing, { recursive: true })
  await execFileAsync("git", ["init", project])
  await writeFile(join(existing, "main.tex"), MAIN)
  let app: ElectronApplication | null = null
  try {
    app = await launch(root, project, existing, {})
    const page = await app.firstWindow()
    await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await openLatexEditor(page)
    const card = page.getByTestId("paper-setup-create")
    await expect(card.getByRole("heading", { level: 3 })).toHaveText("Start draft")
    await expect(page.getByTestId("paper-create")).toHaveText("Start draft")
    await expect(page.getByTestId("paper-create-folder")).toHaveText("paper-2/")
    await expect(page.getByTestId("paper-create")).toBeEnabled()
    await expect(card).not.toContainText("has files in it")
    await page.getByTestId("paper-create-change").click()
    await expect(page.getByRole("alert")).toHaveText(
      "That folder already has files. Choose an empty folder, or use 'Use an existing folder' to open it as a paper.",
    )
    await expect(page.getByTestId("paper-create-folder")).toHaveText("paper-2/")
    await expect(page.getByTestId("paper-create")).toBeEnabled()
    await page.screenshot({ path: test.info().outputPath("latex-start-draft-paper-2.png") })
  } finally {
    if (app) await close(app)
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * Start draft and Connect to Overleaf, through the real app. The paper is
 * made from a template set in Settings > LaTeX (the fixed folder picker
 * returns the template folder). The "Overleaf" Blank project is a LOCAL bare
 * repo (a stand-in: no network, no Overleaf account): a test global Git config
 * holds a `url.<bare repo>.insteadOf` rule for the Overleaf URL, so PI Lab's
 * Overleaf checks see an Overleaf URL while git talks to the local repo.
 */
test("LaTeX Editor creates a paper from the template and connects it to a blank Overleaf project", async () => {
  test.setTimeout(120_000)
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-lab-latex-create-e2e-")))
  const project = join(root, "project")
  await mkdir(project)
  await execFileAsync("git", ["init", project])
  const template = join(root, "my-template")
  await mkdir(template)
  await writeFile(join(template, "main.tex"), MAIN)
  await writeFile(join(template, "refs.bib"), "@misc{a}\n")
  // The Blank Overleaf project: Overleaf's default main.tex on master.
  const blank = join(root, "blank.git")
  await execFileAsync("git", ["init", "--bare", "-b", "master", blank])
  const seed = join(root, "blank-seed")
  await execFileAsync("git", ["init", "-b", "master", seed])
  await writeFile(join(seed, "main.tex"), "\\documentclass{article}\n% Overleaf blank\n")
  await git(seed, "add", ".")
  await git(seed, "commit", "-m", "blank")
  await git(seed, "push", blank, "master")
  const overleafUrl = "https://git@git.overleaf.com/0123456789abcdef01234567"
  // Start draft builds the PDF. With no system LaTeX, Auto uses Tectonic and the shared cache.
  await mkdir(PERSISTENT_CACHE, { recursive: true })
  await mkdir(join(root, "data", "latex"), { recursive: true })
  await symlink(PERSISTENT_CACHE, join(root, "data", "latex", "cache"), "dir")
  const gitConfig = join(root, "gitconfig")
  await writeFile(
    gitConfig,
    `[user]\n\tname = PI Lab Test\n\temail = test@example.invalid\n[url "${blank}"]\n\tinsteadOf = ${overleafUrl}\n`,
  )
  let app: ElectronApplication | null = null
  try {
    // Only the test Git config, and no system config, so a real Overleaf credential in the
    // keychain is not seen.
    app = await launch(root, project, template, {
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
    })
    const page = await app.firstWindow()
    await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    // Settings > LaTeX: set the user's folder as the template.
    await page.getByTestId("nav-settings").click()
    await page.getByTestId("settings-nav-latex").click()
    await expect(page.getByTestId("settings-latex-template-state")).toHaveText("Built-in template")
    await page.getByTestId("settings-latex-template-set").click()
    await expect(page.getByTestId("settings-latex-template-state")).toHaveText(
      `Copied from ${template}`,
    )
    await expect(page.getByTestId("settings-latex-template-clear")).toBeVisible()
    await page.getByTestId("settings-back").click()

    await openLatexEditor(page)
    await expectSetupCards(page)
    await expect(page.getByTestId("paper-create-folder")).toHaveText("paper/")
    await page.screenshot({ path: test.info().outputPath("latex-setup-create.png") })
    await page.getByTestId("paper-create").click()
    // Start draft builds main.tex before the editor opens.
    await expect(page.getByTestId("paper-create")).toHaveText("Building PDF…", {
      timeout: 15_000,
    })
    await expect(page.getByTestId("paper-editor")).toBeVisible({ timeout: 200_000 })
    // main.tex opens on the left with its built PDF already on the right: no save or click.
    const editor = page.getByTestId("central-panel").getByTestId("editor-buffer")
    await expect(editor).toBeVisible()
    /** The PDF viewer shows a rendered page to the right of the source. */
    const expectPdfBeside = async (): Promise<void> => {
      const viewer = page.getByTestId("pdf-viewer")
      await expect(viewer.locator(".page canvas").first()).toBeVisible({ timeout: 15_000 })
      await expect(viewer.locator(".textLayer").first()).toContainText("Shared first line.")
      const source = await editor.boundingBox()
      const pdf = await viewer.boundingBox()
      expect(source && pdf && pdf.x > source.x + source.width / 2).toBe(true)
    }
    // CI runners have no TeX and skip the large TeX bundle download.
    if (!process.env.CI) {
      await expectPdfBeside()
      await page.screenshot({ path: resolve(".cache", "screens", "latex-create-pdf.png") })
    }
    // Opening the LaTeX Editor again for this existing paper shows the PDF on the right.
    await page.getByTestId("nav-dashboard").click()
    await expect(page.getByTestId("paper-editor")).toHaveCount(0)
    await openLatexEditor(page)
    await expect(page.getByTestId("paper-editor")).toBeVisible({ timeout: 15_000 })
    await expect(editor).toBeVisible()
    if (!process.env.CI) await expectPdfBeside()

    // The footer shows the LaTeX engine in use; its menu has no Auto and ticks that engine.
    const engine = page.getByTestId("editor-status-bar").getByTestId("latex-engine")
    await expect(engine).toHaveText(/TeX Live|MiKTeX|System LaTeX|Tectonic/, { timeout: 15_000 })
    const inUse = /Tectonic/.test((await engine.textContent()) ?? "") ? "bundled" : "system"
    await engine.click()
    await expect(page.getByTestId("latex-engine-auto")).toHaveCount(0)
    await expect(page.getByTestId(`latex-engine-${inUse}`)).toHaveAttribute("aria-checked", "true")
    await expect(page.getByTestId("latex-engine-bundled")).toBeVisible()
    await expect(page.getByTestId("latex-engine-install")).toBeEnabled()
    await page.screenshot({ path: test.info().outputPath("latex-engine-menu.png") })
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("latex-engine-bundled")).toHaveCount(0)

    // Update paper (top bar) starts a write-research agent as a focused tab.
    await page.getByTestId("paper-update").click()
    const updateTab = page.getByTestId("central-tab").filter({ hasText: "Update paper" })
    await expect(updateTab).toHaveAttribute("data-active", "true", { timeout: 15_000 })

    const paper = join(project, "paper")
    expect(await readFile(join(paper, "refs.bib"), "utf8")).toBe("@misc{a}\n")
    expect((await git(paper, "ls-files")).trim().split("\n")).toEqual(["main.tex", "refs.bib"])
    // The project repo does not see the paper folder, and the open diary column
    // writes nothing until the user saves an entry.
    expect((await git(project, "status", "--porcelain", "-uall")).trim()).toBe("")

    // No remote yet: Sync is disabled and the footer offers Connect to Overleaf.
    await expect(page.getByTestId("paper-sync")).toBeDisabled()
    await page.getByTestId("paper-connect-overleaf").click()
    const dialog = page.getByTestId("paper-connect-dialog")
    await expect(dialog).toContainText("create a Blank project")
    await expect(dialog).toContainText("Paste it here. Your files replace Overleaf's default ones.")
    await page.screenshot({ path: test.info().outputPath("latex-connect.png") })
    await page.getByTestId("paper-connect-url").fill(overleafUrl)
    await page.getByTestId("paper-connect-token").fill("olp_e2e_token")
    await page.getByTestId("paper-connect-submit").click()
    await expect(dialog).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByTestId("paper-last-sync")).toHaveText("Synced just now")
    await expect(page.getByTestId("paper-connect-overleaf")).toHaveCount(0)
    await expect(page.getByTestId("paper-sync")).toBeEnabled()
    // The local main.tex replaced Overleaf's default one on the remote.
    expect(await git(blank, "show", "master:main.tex")).toBe(MAIN)
    expect(await git(blank, "show", "master:refs.bib")).toBe("@misc{a}\n")
  } finally {
    if (app) await close(app)
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * A paper added with no project, through the real app: New paper… in the
 * LaTeX Editor picker, Start draft into a folder typed in the folder question,
 * then its own Dashboard card (only the paper button), then Link to project,
 * which moves the paper to the project and removes that card. The paper is
 * made from the built-in template; no Overleaf remote is used.
 */
test("LaTeX Editor adds a paper with no project, shows its own card, and links it to a project later", async () => {
  test.setTimeout(240_000)
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-lab-latex-standalone-e2e-")))
  const project = join(root, "project")
  await mkdir(project)
  const paperDir = join(root, "Papers", "thesis")
  await mkdir(PERSISTENT_CACHE, { recursive: true })
  await mkdir(join(root, "data", "latex"), { recursive: true })
  await symlink(PERSISTENT_CACHE, join(root, "data", "latex", "cache"), "dir")
  const gitConfig = join(root, "gitconfig")
  await writeFile(gitConfig, "[user]\n\tname = PI Lab Test\n\temail = test@example.invalid\n")
  let app: ElectronApplication | null = null
  try {
    app = await launch(root, project, root, {
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
    })
    const page = await app.firstWindow()
    await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await page.locator('[data-testid="science-nav-item"][data-science-tab="latex"]').click()
    await expect(page.getByTestId("science-latex")).toBeVisible()
    await page.getByTestId("latex-project-select").click()
    await page.getByRole("option", { name: "New paper…" }).click()
    await expectSetupCards(page)
    await page.getByTestId("paper-create").click()
    const field = page.getByTestId("paper-destination-dir")
    await expect(field).toHaveValue(/Papers\/paper$/)
    await page.screenshot({ path: test.info().outputPath("latex-standalone-destination.png") })
    await field.fill(paperDir)
    await page.getByTestId("paper-destination-ok").click()
    await expect(page.getByTestId("paper-editor")).toBeVisible({ timeout: 200_000 })
    await expect(page.getByTestId("latex-project-select")).toContainText("thesis")
    expect(existsSync(join(paperDir, "main.tex"))).toBe(true)

    // Its own Dashboard card offers only the paper and opens it in the LaTeX Editor.
    await page.getByTestId("nav-dashboard").click()
    const card = page.getByTestId("project-card").filter({ hasText: "thesis" })
    await expect(card).toBeVisible()
    await expect(card.getByTestId("project-card-tasks")).toHaveCount(0)
    await expect(card.getByTestId("project-card-auto-research")).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath("latex-standalone-card.png") })
    await card.getByTestId("project-card-body").click()
    await expect(page.getByTestId("paper-editor")).toBeVisible({ timeout: 30_000 })

    // Link to project moves the paper to the project and removes the paper's own card.
    await page.getByTestId("latex-link-to-project").click()
    await page.getByRole("menuitem", { name: "project" }).click()
    await expect(page.getByTestId("latex-project-select")).toContainText("project")
    await expect(page.getByTestId("paper-editor")).toBeVisible({ timeout: 30_000 })
    await page.getByTestId("nav-dashboard").click()
    await expect(page.getByTestId("project-card")).toHaveCount(1)
    expect(existsSync(join(paperDir, "main.tex"))).toBe(true)
  } finally {
    if (app) await close(app)
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * Real app: like the project view, the editor and the diary are separate rounded
 * cards with 12px gaps between them and from the view's edges, and no line of
 * their own outside a card; collapsed, the diary leaves only a small card with the
 * expand button. The gap left of the diary drags to resize it, and the width comes
 * back after a reload.
 */
test("LaTeX Editor shows the editor and diary as separate cards, and keeps the diary width after reload", async () => {
  test.setTimeout(120_000)
  const root = await mkdtemp(join(tmpdir(), "pi-lab-latex-panels-e2e-"))
  const { project, paper } = await setUp(root)
  let app: ElectronApplication | null = null
  try {
    app = await launch(root, project, paper, {})
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1400, 900))
    await openAndLink(page, "test-echo")
    const latex = page.getByTestId("science-latex")
    const diary = page.getByTestId("latex-diary")
    // The documents column starts collapsed when a paper is opened.
    await expect(diary).toHaveAttribute("data-collapsed", "true")
    await page.getByTestId("latex-diary-expand").click()
    await expect(diary).toHaveAttribute("data-collapsed", "false")
    const box = await latex.getByTestId("central-panel").boundingBox()
    const header = await latex.locator("header").first().boundingBox()
    const shell = await latex.boundingBox()
    const column = await diary.boundingBox()
    if (!box || !header || !shell || !column) throw new Error("No LaTeX Editor layout")
    expect(Math.round(box.y - (header.y + header.height))).toBeGreaterThanOrEqual(12)
    expect(Math.round(box.x - shell.x)).toBeGreaterThanOrEqual(12)
    expect(Math.round(column.x - (box.x + box.width))).toBe(12)
    expect(Math.round(shell.y + shell.height - (box.y + box.height))).toBe(12)
    expect(Math.round(shell.x + shell.width - (column.x + column.width))).toBe(12)
    const style = (locator: typeof diary) =>
      locator.evaluate((element) => {
        const css = getComputedStyle(element)
        return `${css.borderTopLeftRadius} ${css.borderLeftWidth}`
      })
    expect(await style(diary)).toBe("0px 0px")
    expect(await style(diary.getByTestId("right-sidebar"))).toBe("8px 1px")
    expect(await style(latex.getByTestId("central-panel"))).toBe("8px 1px")
    expect(
      await latex
        .locator("header")
        .first()
        .evaluate((el) => getComputedStyle(el).borderBottomWidth),
    ).toBe("0px")
    await page.screenshot({ path: resolve(".cache", "screens", "latex-editor-panels.png") })

    // Collapsed: no card is left; the expand button is at the right end of the
    // editor card's toolbar.
    await diary.getByTestId("right-sidebar-collapse").click()
    await expect(diary).toHaveAttribute("data-collapsed", "true")
    await expect(diary).toBeHidden()
    await expect(latex.getByTestId("central-panel").getByTestId("latex-diary-expand")).toBeVisible()
    await page.getByTestId("latex-diary-expand").click()
    await expect(diary).toHaveAttribute("data-collapsed", "false")

    // Narrow windows: the editor and diary cards stay inside the view's 12px margin.
    for (const [w, h] of [
      [1100, 800],
      [900, 700],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, [width, height]) =>
          BrowserWindow.getAllWindows()[0]?.setSize(width, height),
        [w, h],
      )
      await expect
        .poll(async () => {
          const view = await latex.boundingBox()
          const cards = await Promise.all(
            [latex.getByTestId("central-panel"), diary].map((card) => card.boundingBox()),
          )
          if (!view || cards.some((card) => !card)) return "no layout"
          const right = view.x + view.width - 12
          return cards.every((card) => card && Math.round(card.x + card.width) <= Math.round(right))
            ? "inside"
            : "past the right edge"
        })
        .toBe("inside")
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1400, 900))

    const handle = await page.getByTestId("research-diary-edge-drag").boundingBox()
    if (!handle) throw new Error("No diary resize handle")
    const before = column.width
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width / 2 - 90, handle.y + handle.height / 2, {
      steps: 8,
    })
    await page.mouse.up()
    const width = () => diary.evaluate((element) => element.getBoundingClientRect().width)
    await expect.poll(width).toBe(before + 90)
    // The reload stays on the LaTeX Editor.
    await page.reload()
    await expect(page.getByTestId("paper-editor")).toBeVisible({ timeout: 15_000 })
    await page.getByTestId("latex-diary-expand").click()
    await expect.poll(width).toBe(before + 90)
  } finally {
    if (app) await close(app)
    await rm(root, { recursive: true, force: true })
  }
})
