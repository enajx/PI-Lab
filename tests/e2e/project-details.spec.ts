import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "desktop")
const electronPath = createRequire(join(desktop, "package.json"))("electron") as string

test("compact add/edit preserves project details and opens the selected project's Analysis", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-details-"))
  const folder = join(dataDir, "repo")
  const other = join(dataDir, "other")
  let app: ElectronApplication | undefined
  try {
    await mkdir(folder)
    await mkdir(other)
    await writeFile(join(dataDir, "private-project.md"), "# Private project notes\n")
    await symlink(join(dataDir, "private-project.md"), join(folder, "PROJECT.md"))
    app = await electron.launch({
      executablePath: electronPath,
      args: [join(desktop, "out/main/index.js")],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_TEST_HIDE_WINDOWS: "1",
        PI_LAB_DATA_DIR: dataDir,
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      },
    })
    const window = await app.firstWindow()
    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, folder)
    const startAdd = async () => {
      await window.getByTestId("dashboard-add-project").click()
      await window.getByTestId("add-project-folder").click()
      await expect(window.getByTestId("add-project-dialog")).toBeVisible()
    }
    await startAdd()
    await expect(window.getByTestId("edit-project-name")).toHaveValue("repo")
    await expect(window.getByRole("button", { name: "Plan research", exact: true })).toBeDisabled()
    await window.getByTestId("edit-project-cancel").click()
    await expect(window.getByTestId("project-card")).toHaveCount(0)
    await startAdd()
    await window.getByTestId("edit-project-name").fill("Project One")
    await expect(window.getByTestId("edit-project-type")).toHaveCount(0)
    await expect(window.getByTestId("edit-project-deadline")).toHaveCount(0)
    await expect(window.getByTestId("edit-project-tag-text")).toHaveCount(0)
    const planBox = await window.getByRole("button", { name: "Plan research" }).boundingBox()
    const cancelBox = await window.getByTestId("edit-project-cancel").boundingBox()
    expect(planBox && cancelBox && planBox.x < cancelBox.x).toBe(true)
    await expect(window.getByTestId("edit-project-agent")).toHaveValue("")
    await window
      .getByTestId("add-project-dialog")
      .screenshot({ path: "/tmp/pi-lab-add-project-dialog.png" })
    await window.getByTestId("add-project-confirm").click()
    await expect(window.getByTestId("add-project-dialog")).toHaveCount(0)
    await expect(window.getByTestId("project-setup-wizard")).toHaveCount(0)
    let card = window.getByTestId("project-card").filter({ hasText: "Project One" })
    await expect(card.getByTestId("project-card-fetch-experiments")).toHaveCount(0)
    await expect(card.locator('[data-testid^="project-card-type-"]')).toHaveCount(0)
    await card
      .getByTestId("project-card-body")
      .click({ button: "right", position: { x: 24, y: 24 } })
    await window.getByTestId("project-card-menu-edit").click()
    await expect(window.getByTestId("edit-project-name")).toHaveValue("Project One")
    await window.getByTestId("edit-project-deadline").fill("2027-03-12")
    await window.getByTestId("edit-project-tag-text").fill("Baseline")
    await window.getByTestId("edit-project-tag-add").click()
    await window.getByTestId("edit-project-emoji-choice").first().click()
    await expect(window.getByText("Tags", { exact: true })).toBeVisible()
    await expect(window.getByLabel("Tag color", { exact: true })).toHaveCount(0)
    await window
      .getByTestId("edit-project-dialog")
      .screenshot({ path: "/tmp/pi-lab-edit-project-tags.png" })
    await window.getByTestId("edit-project-name").fill("Project Renamed")
    await window.getByTestId("edit-project-type").selectOption("manuscript")
    await window.getByTestId("edit-project-deadline").fill("")
    await window.getByTestId("edit-project-save").click()
    await expect(window.getByTestId("edit-project-dialog")).toHaveCount(0)
    await window.reload()
    await expect(window.getByTestId("app-ready")).toBeVisible()
    card = window.getByTestId("project-card").filter({ hasText: "Project Renamed" })
    await expect(card).toContainText("Baseline")
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, other)
    await startAdd()
    await window.getByTestId("add-project-confirm").click()
    await expect(window.getByTestId("project-card")).toHaveCount(2)
    await card.getByTestId("project-card-analysis").click()
    await expect(
      window.getByTestId("analysis-project-select").locator("option:checked"),
    ).toHaveText("Project Renamed")
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
