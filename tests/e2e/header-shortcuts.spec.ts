import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
