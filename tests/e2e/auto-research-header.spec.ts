import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { _electron as electron, expect, test } from "./fixtures/playwright"

const execFileAsync = promisify(execFile)

/** Real project button, IPC, Git worktree and fixture agent process. */
test("project Auto research leads the header and launches the existing worktree agent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-auto-research-header-"))
  const gitRoot = join(dir, "repository")
  const repo = join(gitRoot, "project")
  await mkdir(repo, { recursive: true })
  await execFileAsync("git", ["init", "-b", "main", gitRoot])
  await writeFile(join(repo, "PROJECT.md"), "# Fixture project\n")
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
      PI_LAB_TEST_AGENT_ID: "test-echo",
    },
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId("project-item")).toBeVisible()
    // Seed the remembered fixture agent; the button still crosses real launch and Git boundaries.
    await execFileAsync("/usr/bin/sqlite3", [
      join(dir, "data", "local.db"),
      `UPDATE projects SET agent_config='{"agentId":"test-echo"}'`,
    ])
    await page.getByTestId("project-item").click()
    const button = page.getByTestId("project-view-auto-research")
    await expect(button).toBeEnabled()
    expect(
      await button.evaluate((element) => element.nextElementSibling?.getAttribute("data-testid")),
    ).toBe("project-view-plan-research")
    await expect(page.getByTestId("project-view-fetch-experiments")).toHaveCount(0)
    await button.click()
    await expect(page.getByTestId("terminal")).toContainText("AGENT-UI-OK", { timeout: 15000 })
    await expect(
      page.getByTestId("central-tab-select").filter({ hasText: "Auto-research" }),
    ).toBeVisible()
    const worktrees = (
      await execFileAsync("git", ["-C", repo, "worktree", "list", "--porcelain"])
    ).stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice(9))
    expect(worktrees).toHaveLength(2)
    const isolated = worktrees.find((path) => path !== gitRoot && !path.endsWith("/repository"))
    expect(isolated).toBeTruthy()
    expect(
      await readFile(join(isolated as string, "project", "AUTORESEARCH.md"), "utf8"),
    ).toContain("placeholder")
  } finally {
    // The test-mode dialog responder answers the quit confirmation with Quit.
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
