import { cp, mkdtemp, rm, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = join(here, "..", "..", "apps", "desktop")
const mainEntry = join(desktopDir, "out", "main", "index.js")
const electronPath = createRequire(join(desktopDir, "package.json"))("electron") as string
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional packaged Alpha test target.
const packagedBinary = process.env.PI_LAB_PACKAGED_BINARY

let app: ElectronApplication
let dataDir: string
let sample: string

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-alpha-examples-"))
  sample = join(dataDir, "python-research")
  await cp(join(here, "..", "test-projects", "python-research"), sample, { recursive: true })
  app = await electron.launch({
    executablePath: packagedBinary ?? electronPath,
    args: packagedBinary ? [] : [mainEntry],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_TEST_FIRST_RUN: "1",
      PI_LAB_TEST_HIDE_WINDOWS: "1",
      PI_LAB_TEST_PICK_DIRECTORY: sample,
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
    },
  })
})

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("Alpha can add an example, clear its project list, and repeat setup separately", async () => {
  const window = await app.firstWindow()
  window.on("dialog", (dialog) => void dialog.accept())

  await expect(window.getByTestId("first-run-setup")).toBeVisible({ timeout: 30_000 })
  await window.getByRole("button", { name: "Finish setup" }).click()
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })

  const addExample = async () => {
    await window.getByTestId("dashboard-add-project").click()
    await window.getByTestId("add-project-folder").click()
    await expect(window.getByTestId("add-project-dialog")).toHaveCount(0)
    await expect(
      window.getByTestId("project-item").filter({ hasText: "python-research" }),
    ).toBeVisible()
  }

  await addExample()
  await window.getByTestId("nav-settings").click()
  await expect(window.getByTestId("alpha-testing-resets")).toBeVisible()
  const keepRunning = window.getByTestId("settings-keep-running-after-close")
  await keepRunning.click()
  await expect(keepRunning).toHaveAttribute("aria-checked", "false")
  await window.getByTestId("alpha-clear-projects").click()
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-item")).toHaveCount(0)
  expect((await stat(sample)).isDirectory()).toBe(true)

  await addExample()
  await window.getByTestId("nav-settings").click()
  await expect(keepRunning).toHaveAttribute("aria-checked", "false")
  await window.getByTestId("alpha-reset-settings").click()
  await expect(window.getByTestId("first-run-setup")).toBeVisible({ timeout: 30_000 })
  await window.getByRole("button", { name: "Finish setup" }).click()
  await expect(
    window.getByTestId("project-item").filter({ hasText: "python-research" }),
  ).toBeVisible()
  await window.getByTestId("nav-settings").click()
  await expect(keepRunning).toHaveAttribute("aria-checked", "true")
})
