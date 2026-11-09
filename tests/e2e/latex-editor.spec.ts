import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
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

/** Start the real desktop build with isolated data, the project open, and a fixed folder picker. */
async function launch(
  root: string,
  project: string,
  pickDir: string,
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
      PI_LAB_DATA_DIR: root,
      PI_LAB_SOCKET_PATH: join(root, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: project,
      PI_LAB_TEST_PICK_DIRECTORY: pickDir,
      PI_LAB_TEST_AGENT_ID: "test-echo",
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

/** Open LaTeX Editor from the project's dashboard card and link the paper folder. */
async function openAndLink(page: Page): Promise<void> {
  await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await page.getByTestId("nav-dashboard").click()
  // Background agent work (Ask agent to merge) uses the deterministic test merge agent.
  await page
    .getByTestId("project-card")
    .getByTestId("project-card-body")
    .click({ button: "right", position: { x: 24, y: 24 } })
  await page.getByTestId("project-card-menu-edit").click()
  await page.getByTestId("edit-project-agent").selectOption("test-merge")
  await page.getByTestId("edit-project-save").click()
  await page.getByTestId("project-card").getByTestId("project-card-latex").click()
  await expect(page.getByTestId("science-latex")).toBeVisible()
  await expect(page.getByTestId("latex-project-select")).toHaveValue(/.+/)
  await page.getByTestId("paper-use-folder").click()
  await expect(page.getByTestId("paper-editor")).toBeVisible({ timeout: 15_000 })
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
    app = await launch(root, project, paper)
    const page = await app.firstWindow()
    await openAndLink(page)

    // Outline, file list, and the main .tex open with LaTeX colouring.
    await expect(page.getByTestId("paper-outline-entry")).toHaveText(["Introduction", "Method"])
    await expect(page.getByTestId("paper-file").filter({ hasText: "main.tex" })).toBeVisible()
    const editor = page.getByTestId("editor-buffer")
    await expect(editor.locator(".cm-content")).toContainText("Shared first line.")
    await expect(editor.locator(".cm-line span").first()).toBeVisible()
    await page.getByTestId("paper-outline-entry").filter({ hasText: "Method" }).click()

    // Sync asks before committing edits not yet sent; "Don't ask again" sticks.
    await writeFile(join(paper, "main.tex"), MAIN.replace("Method text.", "Local method text."))
    await page.getByTestId("paper-sync").click()
    await expect(page.getByTestId("paper-commit-dialog")).toContainText("main.tex")
    await page.getByTestId("paper-commit-dont-ask").check()
    await page.getByTestId("paper-commit-confirm").click()
    await expect(page.getByTestId("paper-last-sync")).toContainText("Last Overleaf sync", {
      timeout: 15_000,
    })
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

/** Real build through bundled Tectonic: the PDF opens beside the source. */
test("LaTeX Editor builds the paper and shows the PDF beside the source", async () => {
  // CI runners skip the large TeX bundle download to save credits.
  test.skip(Boolean(process.env.CI), "Downloads the TeX bundle; run locally")
  test.setTimeout(300_000)
  const root = await mkdtemp(join(tmpdir(), "pi-lab-latex-editor-build-e2e-"))
  const { project, paper } = await setUp(root)
  await mkdir(PERSISTENT_CACHE, { recursive: true })
  await mkdir(join(root, "latex"))
  await symlink(PERSISTENT_CACHE, join(root, "latex", "cache"), "dir")
  let app: ElectronApplication | null = null
  try {
    app = await launch(root, project, paper)
    const page = await app.firstWindow()
    await openAndLink(page)
    const editor = page.getByTestId("editor-buffer")
    await editor.locator(".cm-content").click()
    await page.keyboard.press("ControlOrMeta+s")
    await expect(page.locator('[data-testid="latex-build-status"]:visible')).toContainText(
      /complete/i,
      { timeout: 200_000 },
    )
    await page.getByTestId("latex-show-pdf").click()
    const viewer = page.getByTestId("pdf-viewer")
    await expect(viewer).toBeVisible({ timeout: 15_000 })
    const source = await editor.boundingBox()
    const pdf = await viewer.boundingBox()
    expect(source && pdf && pdf.x > source.x + source.width / 2).toBe(true)
  } finally {
    if (app) await close(app)
    await rm(root, { recursive: true, force: true })
  }
})
