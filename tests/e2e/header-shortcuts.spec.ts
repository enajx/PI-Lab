import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { _electron as electron, expect, test } from "./fixtures/playwright"

const execFileAsync = promisify(execFile)

/**
 * Real app, IPC, skill discovery and fixture agent process: the Project view
 * header "+" menu adds a project skill as a shortcut, the shortcut starts the
 * project's agent in a new tab, the Project status button is icon-only, and the
 * chosen list survives a relaunch.
 */
test("a skill added from the header + menu starts an agent and the list persists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-header-shortcuts-"))
  const repo = join(dir, "project")
  const skillDir = join(repo, ".claude", "skills", "review-notes")
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(repo, "PROJECT.md"), "# Fixture project\n")
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: Review notes\ndescription: Review the lab notes\n---\nReview the notes.\n",
  )
  await execFileAsync("git", ["init", "-b", "main", repo])
  await execFileAsync("git", ["-C", repo, "add", "."])
  await execFileAsync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-m",
    "Fixture",
  ])
  const desktop = join(process.cwd(), "apps/desktop")
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional packaged app verification.
  const binary = process.env.PI_LAB_PACKAGED_BINARY
  const launch = () =>
    electron.launch({
      executablePath: binary ?? createRequire(join(desktop, "package.json"))("electron"),
      args: binary ? [] : [join(desktop, "out/main/index.js")],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: join(dir, "data"),
        PI_LAB_SOCKET_PATH: join(dir, "daemon.sock"),
        PI_LAB_TEST_OPEN_PROJECT: repo,
        PI_LAB_TEST_AGENT_ID: "test-echo",
      },
    })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    await expect(page.getByTestId("project-item")).toBeVisible()
    // Seed the remembered fixture agent; the launch still crosses the real PTY boundary.
    await execFileAsync("/usr/bin/sqlite3", [
      join(dir, "data", "local.db"),
      `UPDATE projects SET agent_config='{"agentId":"test-echo"}'`,
    ])
    await page.getByTestId("project-item").click()
    const status = page.getByTestId("project-view-status")
    await expect(status).toHaveAttribute("title", "Project status")
    await expect(status).toHaveText("")

    await page.getByTestId("project-view-shortcuts-add").click()
    const menu = page.getByRole("menu", { name: "Header shortcuts" })
    await expect(menu.getByRole("menuitemcheckbox", { name: "Tasks" })).toHaveAttribute(
      "aria-checked",
      "true",
    )
    await menu.getByRole("button", { name: "Skills" }).click()
    await menu.getByRole("menuitemcheckbox", { name: "Review notes" }).click()
    await page.keyboard.press("Escape")

    const skillButton = page.getByTestId("project-view-shortcut-skill-review-notes")
    await expect(skillButton).toBeEnabled()
    await skillButton.click()
    await expect(page.getByTestId("terminal")).toContainText("AGENT-UI-OK", { timeout: 15000 })
    await expect(
      page.getByTestId("central-tab-select").filter({ hasText: "Review notes" }),
    ).toBeVisible()

    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await page.getByTestId("project-item").click()
    await expect(page.getByTestId("project-view-shortcut-skill-review-notes")).toBeVisible()
  } finally {
    // The test-mode dialog responder answers the quit confirmation with Quit.
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * Real app, IPC, bundled skill lookup and fixture agent process: the LaTeX
 * Editor top bar has its own "+" menu listing Update paper, and Analysis shows
 * Analyze experiments by default, which starts the project's agent in the
 * Analysis session panel.
 */
test("LaTeX Editor and Analysis have their own top bar + menu", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-view-shortcuts-"))
  const repo = join(dir, "project")
  const paper = join(repo, "paper")
  await mkdir(paper, { recursive: true })
  await writeFile(join(repo, "PROJECT.md"), "# Fixture project\n")
  await writeFile(
    join(paper, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n",
  )
  await execFileAsync("git", ["init", "-b", "main", repo])
  await execFileAsync("git", ["-C", repo, "add", "."])
  await execFileAsync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-m",
    "Fixture",
  ])
  const desktop = join(process.cwd(), "apps/desktop")
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional packaged app verification.
  const binary = process.env.PI_LAB_PACKAGED_BINARY
  const app = await electron.launch({
    executablePath: binary ?? createRequire(join(desktop, "package.json"))("electron"),
    args: binary ? [] : [join(desktop, "out/main/index.js")],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: join(dir, "data"),
      PI_LAB_SOCKET_PATH: join(dir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: repo,
      PI_LAB_TEST_PICK_DIRECTORY: paper,
      PI_LAB_TEST_AGENT_ID: "test-echo",
    },
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("project-item")).toBeVisible()
    // Seed the remembered fixture agent; the launch still crosses the real PTY boundary.
    await execFileAsync("/usr/bin/sqlite3", [
      join(dir, "data", "local.db"),
      `UPDATE projects SET agent_config='{"agentId":"test-echo"}'`,
    ])

    // LaTeX Editor: link the paper folder, then open the top bar "+" menu.
    await page.getByTestId("nav-dashboard").click()
    await page.getByTestId("project-card").getByTestId("project-card-latex").click()
    await expect(page.getByTestId("science-latex")).toBeVisible()
    await page.getByTestId("paper-use-folder").click()
    await expect(page.getByTestId("paper-editor")).toBeVisible({ timeout: 15_000 })
    await page.getByTestId("latex-shortcuts-add").click()
    const menu = page.getByRole("menu", { name: "Header shortcuts" })
    // The menu lists the LaTeX Editor's own top bar buttons, all shown.
    await expect(menu.getByRole("menuitemcheckbox")).toHaveText(["Update paper", "Sync"])
    for (const name of ["Update paper", "Sync"])
      await expect(menu.getByRole("menuitemcheckbox", { name })).toHaveAttribute(
        "aria-checked",
        "true",
      )
    await menu.getByRole("button", { name: "Skills" }).click()
    await page.screenshot({ path: resolve(".cache", "screens", "shortcut-menu.png") })
    // The menu is small: narrow, with short rows.
    const box = await menu.boundingBox()
    expect(box?.width ?? 0).toBeLessThanOrEqual(230)
    const row = await menu.getByRole("menuitemcheckbox", { name: "Update paper" }).boundingBox()
    expect(row?.height ?? 0).toBeLessThanOrEqual(26)
    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)

    // Analysis: Analyze experiments is in the top bar and opens its agent in the session panel.
    await page.locator('[data-testid="science-nav-item"][data-science-tab="analysis"]').click()
    await expect(page.getByTestId("science-analysis")).toBeVisible({ timeout: 30_000 })
    // Its "+" menu lists every button of the Analysis top bar, all shown.
    await page.getByTestId("analysis-shortcuts-add").click()
    const analysisItems = menu.getByRole("menuitemcheckbox")
    await expect(analysisItems).toHaveText([
      "Analyze experiments",
      "Report",
      "Fetch experiments",
      "Research diary",
    ])
    for (const name of ["Analyze experiments", "Report", "Fetch experiments", "Research diary"])
      await expect(menu.getByRole("menuitemcheckbox", { name })).toHaveAttribute(
        "aria-checked",
        "true",
      )
    await page.screenshot({ path: resolve(".cache", "screens", "analysis-menu.png") })
    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)
    const analyze = page.getByTestId("analysis-analyze-experiments")
    await expect(analyze).toBeEnabled()
    await analyze.click()
    const panel = page.getByTestId("science-sessions")
    await expect(panel).toHaveAttribute("data-collapsed", "false")
    await expect(panel.getByTestId("terminal")).toContainText("AGENT-UI-OK", { timeout: 15000 })
    await expect(
      panel.getByTestId("central-tab-select").filter({ hasText: "Analyze experiments" }),
    ).toBeVisible()
  } finally {
    // The test-mode dialog responder answers the quit confirmation with Quit.
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * Real app and window chrome: an open "+" menu turns the LaTeX Editor top bar
 * (a window drag region, which Electron keeps from the page) into a normal page
 * area, so a click on the top bar title closes the menu. The top bar project
 * picker is the app's own dropdown and switches the project.
 */
test("a click on the top bar closes the + menu, and the project picker switches projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-popup-dismiss-"))
  const repos = { alpha: join(dir, "alpha"), beta: join(dir, "beta") }
  for (const repo of Object.values(repos)) {
    await mkdir(join(repo, "paper"), { recursive: true })
    await writeFile(join(repo, "PROJECT.md"), "# Fixture project\n")
    await writeFile(
      join(repo, "paper", "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n",
    )
    await execFileAsync("git", ["init", "-b", "main", repo])
    await execFileAsync("git", ["-C", repo, "add", "."])
    await execFileAsync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "Fixture",
    ])
  }
  const desktop = join(process.cwd(), "apps/desktop")
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional packaged app verification.
  const binary = process.env.PI_LAB_PACKAGED_BINARY
  // Each launch opens one more project into the same data folder.
  const launch = (repo: string) =>
    electron.launch({
      executablePath: binary ?? createRequire(join(desktop, "package.json"))("electron"),
      args: binary ? [] : [join(desktop, "out/main/index.js")],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: join(dir, "data"),
        PI_LAB_SOCKET_PATH: join(dir, "daemon.sock"),
        PI_LAB_TEST_OPEN_PROJECT: repo,
        PI_LAB_TEST_PICK_DIRECTORY: join(repos.alpha, "paper"),
      },
    })
  let app = await launch(repos.beta)
  try {
    let page = await app.firstWindow()
    await expect(page.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
    await app.close()
    app = await launch(repos.alpha)
    page = await app.firstWindow()
    await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("project-item")).toHaveCount(2)

    await page.getByTestId("nav-dashboard").click()
    await page
      .getByTestId("project-card")
      .filter({ hasText: "alpha" })
      .getByTestId("project-card-latex")
      .click()
    await expect(page.getByTestId("science-latex")).toBeVisible()
    await page.getByTestId("paper-use-folder").click()
    await expect(page.getByTestId("paper-editor")).toBeVisible({ timeout: 15_000 })

    // The top bar is a window drag region until a menu opens.
    const topBar = page.getByTestId("science-latex").locator("header").first()
    const appRegion = () =>
      topBar.evaluate((element) => {
        const style = getComputedStyle(element)
        return style.getPropertyValue("-webkit-app-region") || style.getPropertyValue("app-region")
      })
    expect(await appRegion()).toBe("drag")
    await page.getByTestId("latex-shortcuts-add").click()
    const menu = page.getByRole("menu", { name: "Header shortcuts" })
    await expect(menu).toBeVisible()
    expect(await appRegion()).toBe("no-drag")
    await topBar.locator("h1").click()
    await expect(menu).toHaveCount(0)
    expect(await appRegion()).toBe("drag")

    // The project picker is the app's own dropdown; it lists both projects.
    const picker = page.getByTestId("latex-project-select")
    await expect(picker).toHaveText("alpha")
    await picker.click()
    const list = page.getByRole("listbox", { name: "LaTeX Editor project" })
    await expect(list.getByRole("option")).toHaveCount(2)
    await expect(list.getByRole("option", { name: "beta" })).toHaveAttribute(
      "aria-selected",
      "false",
    )
    await expect(list.getByRole("option", { name: "alpha" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    await page.screenshot({ path: resolve(".cache", "screens", "project-picker.png") })
    await list.getByRole("option", { name: "beta" }).click()
    await expect(list).toHaveCount(0)
    await expect(picker).toHaveText("beta")
  } finally {
    // The test-mode dialog responder answers the quit confirmation with Quit.
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * Real app and router: the Project view header shows Tasks, Paper, Auto
 * research and Plan research as icon-only buttons named in their title, and
 * the Paper button opens the LaTeX Editor with that project chosen.
 */
test("the project view Paper button opens the LaTeX Editor with the project chosen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-project-paper-"))
  const repos = { alpha: join(dir, "alpha"), beta: join(dir, "beta") }
  for (const repo of Object.values(repos)) {
    await mkdir(repo, { recursive: true })
    await writeFile(join(repo, "PROJECT.md"), "# Fixture project\n")
    await execFileAsync("git", ["init", "-b", "main", repo])
    await execFileAsync("git", ["-C", repo, "add", "."])
    await execFileAsync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "Fixture",
    ])
  }
  const desktop = join(process.cwd(), "apps/desktop")
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional packaged app verification.
  const binary = process.env.PI_LAB_PACKAGED_BINARY
  // Each launch opens one more project into the same data folder.
  const launch = (repo: string) =>
    electron.launch({
      executablePath: binary ?? createRequire(join(desktop, "package.json"))("electron"),
      args: binary ? [] : [join(desktop, "out/main/index.js")],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: join(dir, "data"),
        PI_LAB_SOCKET_PATH: join(dir, "daemon.sock"),
        PI_LAB_TEST_OPEN_PROJECT: repo,
      },
    })
  let app = await launch(repos.beta)
  try {
    let page = await app.firstWindow()
    await expect(page.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
    await app.close()
    app = await launch(repos.alpha)
    page = await app.firstWindow()
    await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("project-item")).toHaveCount(2)

    await page.getByTestId("project-item").filter({ hasText: "alpha" }).click()
    const paper = page.getByTestId("project-header-paper")
    await expect(paper).toBeVisible()
    for (const [testId, name] of [
      ["project-view-tasks", "Tasks"],
      ["project-header-paper", "Paper"],
      ["project-view-auto-research", "Auto research"],
      ["project-view-plan-research", "Plan research"],
    ]) {
      const button = page.getByTestId(testId)
      await expect(button).toHaveText("")
      await expect(button).toHaveAttribute("title", name)
    }
    await page.screenshot({ path: resolve(".cache", "screens", "project-header.png") })
    await page.getByTestId("project-view-shortcuts-add").click()
    const menu = page.getByRole("menu", { name: "Header shortcuts" })
    await expect(menu.getByRole("menuitemcheckbox", { name: "Paper" })).toHaveAttribute(
      "aria-checked",
      "true",
    )
    await page.keyboard.press("Escape")

    await paper.click()
    await expect(page.getByTestId("science-latex")).toBeVisible()
    await expect(page.getByTestId("latex-project-select")).toHaveText("alpha")

    // From another project's view, Paper switches the LaTeX Editor to that project.
    await page.getByTestId("project-item").filter({ hasText: "beta" }).click()
    await page.getByTestId("project-header-paper").click()
    await expect(page.getByTestId("science-latex")).toBeVisible()
    await expect(page.getByTestId("latex-project-select")).toHaveText("beta")
  } finally {
    // The test-mode dialog responder answers the quit confirmation with Quit.
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
