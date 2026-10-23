import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _electron as electron, expect, test } from "@playwright/test"

/** Real renderer, IPC, skill filesystem and fixture agent; no external AI service. */
test("Plan research reports a missing skill and runs a user skill after installation", async () => {
  const desktop = join(process.cwd(), "apps/desktop")
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-plan-research-"))
  const repo = join(dataDir, "project")
  await mkdir(repo)
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional real packaged app verification.
  const binary = process.env.PI_LAB_PACKAGED_BINARY
  const app = await electron.launch({
    executablePath: binary ?? createRequire(join(desktop, "package.json"))("electron"),
    args: binary ? [] : [join(desktop, "out/main/index.js")],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_SKILLS_HOME: join(dataDir, "home"),
      PI_LAB_TEST_OPEN_PROJECT: repo,
      PI_LAB_TEST_AGENT_ID: "test-echo",
    },
  })
  try {
    const window = await app.firstWindow()
    await expect(window.getByTestId("project-item")).toHaveCount(1)
    await window.getByTestId("project-item").click()
    await window.getByTestId("project-view-plan-research").click()
    await expect(window.getByTestId("workflow-result-error")).toContainText(
      "Plan research skill could not be found",
    )
    const dialog = window.getByTestId("workflow-result-dialog")
    expect((await dialog.boundingBox())?.width).toBeLessThanOrEqual(475)
    await expect(window.getByTestId("workflow-activity-log")).toHaveCount(0)
    await expect(window.getByTestId("workflow-result-error")).not.toHaveClass(/text-destructive/)
    await window.getByTestId("workflow-result-close").click()
    await expect(window.getByTestId("project-view-plan-research")).not.toHaveClass(
      /text-red|border-red/,
    )
    const skillDir = join(dataDir, "home", ".agents", "skills", "plan-research")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "# Plan research\nDescribe the research question.")
    await window.getByTestId("project-view-plan-research").click()
    await expect(window.getByTestId("workflow-result-error")).toHaveCount(0)
    await expect(window.getByTestId("workflow-result-text")).toBeVisible({ timeout: 20_000 })
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
