import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

test("the sidebar follows agent activity while the Dashboard is unmounted", async () => {
  test.setTimeout(60_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-shell-activity-"))
  const repoDir = join(dataDir, "repo")
  let app: ElectronApplication | null = null
  try {
    await execFileAsync("git", ["init", "-b", "main", repoDir])
    await writeFile(join(repoDir, "README.md"), "# Activity fixture\n")
    app = await electron.launch({
      executablePath: ELECTRON_PATH,
      args: [MAIN_ENTRY],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: dataDir,
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
        PI_LAB_TEST_OPEN_PROJECT: repoDir,
        PI_LAB_TEST_AGENT_ID: "test-echo",
      },
    })
    const window = await app.firstWindow()
    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    const status = window.getByTestId("project-agent-status")
    await expect(status).toHaveAttribute("data-status", "empty")

    await window.getByTestId("project-item").click()
    await expect(window.getByTestId("dashboard")).toHaveCount(0)
    await window.getByTestId("central-new-agent").click()
    const chooser = window.getByTestId("new-agent-dialog")
    await chooser.locator("label", { hasText: "Test Activity" }).click()
    await chooser.getByRole("button", { name: "Start agent" }).click()
    await expect(window.getByTestId("terminal")).toContainText("AGENT-ACTIVE", { timeout: 30_000 })
    await expect(status).toHaveAttribute("data-status", "working", { timeout: 5_000 })

    await window.getByTestId("central-tab-close").click()
    await expect(status).toHaveAttribute("data-status", "empty", { timeout: 5_000 })
    await expect(window.getByTestId("dashboard")).toHaveCount(0)
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
