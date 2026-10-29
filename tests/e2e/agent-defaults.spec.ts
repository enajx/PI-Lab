import { execFile } from "node:child_process"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  test,
} from "./fixtures/playwright"

const execFileAsync = promisify(execFile)
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "desktop")
const electronPath = createRequire(join(desktop, "package.json"))("electron") as string

/** Shipping UI/IPC/daemon/PTY with credential-free provider executables that print argv. */
test("Settings defaults reach new agents and a one-off provider leaves the project choice unchanged", async () => {
  test.skip(process.platform === "win32", "Fixture uses POSIX shell")
  test.setTimeout(90_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-agent-defaults-"))
  const repoDir = join(dataDir, "repo")
  const fixture = join(dataDir, "agent-fixture")
  let app: ElectronApplication | undefined
  try {
    await execFileAsync("git", ["init", "-b", "main", repoDir])
    await writeFile(join(repoDir, "notes.md"), "# Agent defaults fixture\n")
    await execFileAsync("git", ["-C", repoDir, "add", "."])
    await execFileAsync("git", [
      "-C",
      repoDir,
      "-c",
      "user.name=PI Lab Test",
      "-c",
      "user.email=test@pi-lab.local",
      "commit",
      "-m",
      "fixture",
    ])
    await writeFile(fixture, '#!/bin/sh\nprintf "ARG:%s\\n" "$@"\nexec /bin/cat\n')
    await chmod(fixture, 0o755)
    app = await electron.launch({
      executablePath: electronPath,
      args: [join(desktop, "out", "main", "index.js")],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: dataDir,
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
        PI_LAB_TEST_OPEN_PROJECT: repoDir,
      },
    })
    const window = await app.firstWindow()
    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await window.getByTestId("nav-settings").click()
    await window.getByTestId("settings-nav-agents").click()
    for (const id of ["codex", "claude-code"]) {
      const executable = window.getByTestId(`settings-agent-executable-${id}`)
      await executable.fill(fixture)
      await executable.blur()
      await expect(window.getByText(`Detected: ${fixture}`).first()).toBeVisible()
    }
    await window.getByTestId("settings-default-agent").selectOption("codex")
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-lab.defaultAgentId")))
      .toBe("codex")
    await window.getByTestId("settings-agent-model-codex").fill("fixture-model")
    await window.getByTestId("settings-agent-model-codex").blur()
    await window.getByTestId("settings-agent-effort-codex").selectOption("high")
    await window.getByTestId("settings-back").click()
    await window.getByTestId("project-item").click()
    await window.getByTestId("central-new-agent").click()
    await expect(window.locator('[data-testid="terminal"]:visible')).toContainText(
      "ARG:fixture-model",
    )
    await expect(window.locator('[data-testid="terminal"]:visible')).toContainText(
      'ARG:model_reasoning_effort="high"',
    )
    await window.getByTestId("central-add-menu").click()
    await window.getByTestId("central-add-agent").click()
    await window.getByTestId("new-agent-dialog").getByLabel("Claude Code").locator("..").click()
    await window
      .getByTestId("new-agent-dialog")
      .getByRole("button", { name: "Start agent" })
      .click()
    await expect(window.locator('[data-testid="terminal"]:visible')).toContainText(
      "ARG:--dangerously-skip-permissions",
    )
    await window.getByTestId("central-new-agent").click()
    await expect(window.locator('[data-testid="terminal"]:visible')).toContainText(
      "ARG:fixture-model",
    )
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-lab.defaultAgentId")))
      .toBe("codex")
    await window.getByTestId("nav-dashboard").click()
    await window
      .getByTestId("project-card-body")
      .click({ button: "right", position: { x: 24, y: 24 } })
    await window.getByTestId("project-card-menu-edit").click()
    await expect(window.getByTestId("edit-project-agent")).toHaveValue("")
  } finally {
    if (app) {
      // The test-mode dialog responder answers the quit confirmation with Quit.
      await app.close()
    }
    await rm(dataDir, { recursive: true, force: true })
  }
})
