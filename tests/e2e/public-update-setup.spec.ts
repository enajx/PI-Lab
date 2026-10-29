import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  test,
} from "./fixtures/playwright"

// biome-ignore lint/suspicious/noUndeclaredEnvVars: Explicit isolated packaged Beta test target.
const binary = process.env.PI_LAB_PACKAGED_BETA_BINARY
let app: ElectronApplication | undefined
let dataDir = ""

/** Exercise real packaged release metadata, setup persistence, and a fresh process. */
async function launch() {
  if (!binary) throw new Error("PI_LAB_PACKAGED_BETA_BINARY is required")
  return electron.launch({
    executablePath: binary,
    args: [],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_TEST_FIRST_RUN: "1",
      PI_LAB_TEST_HIDE_WINDOWS: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
    },
  })
}

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("packaged Beta setup starts on Beta and preserves a chosen Stable channel", async () => {
  test.skip(!binary, "Requires an isolated packaged Beta app")
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-beta-setup-"))
  app = await launch()
  let window = await app.firstWindow()
  await expect(window.getByTestId("first-run-setup")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByLabel("Update channel", { exact: true })).toHaveValue("beta")
  await window.getByLabel("Update channel", { exact: true }).selectOption("stable")
  await expect(window.getByRole("button", { name: "Finish setup" })).toBeEnabled()
  await window.getByRole("button", { name: "Finish setup" }).click()
  await expect(window.getByTestId("dashboard")).toBeVisible()
  await app.close()
  app = undefined
  app = await launch()
  window = await app.firstWindow()
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })
  await window.keyboard.press("ControlOrMeta+p")
  await window.getByTestId("command-palette-input").fill("Run first-launch setup")
  await window.locator('[data-command-id="open-first-run-setup"]').click()
  await expect(window.getByLabel("Update channel", { exact: true })).toHaveValue("stable")
})
