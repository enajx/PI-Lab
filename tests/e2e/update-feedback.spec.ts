import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  test,
} from "./fixtures/playwright"

const desktop = join(process.cwd(), "apps/desktop")
const executablePath = createRequire(join(desktop, "package.json"))("electron") as string
let app: ElectronApplication
let dataDir: string

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-update-feedback-"))
  app = await electron.launch({
    executablePath,
    args: [join(desktop, "out/main/index.js")],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
    },
  })
})
test.afterEach(async () => {
  await app?.close()
  await rm(dataDir, { recursive: true, force: true })
})

test("Settings and command palette check updates through the real IPC bridge", async () => {
  const page = await app.firstWindow()
  await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await page.keyboard.press("ControlOrMeta+,")
  await page.getByTestId("settings-check-for-updates").click({ timeout: 5000 })
  await expect(page.getByTestId("update-notice")).toContainText("This build does not auto-update")
  await expect(page.getByTestId("update-notice")).toBeHidden({ timeout: 4500 })
  await page.keyboard.press("ControlOrMeta+p")
  await page.getByTestId("command-palette-input").fill("Check for updates")
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("update-notice")).toContainText("This build does not auto-update")
})

test("injected update events render ready and installed notices through Electron IPC", async () => {
  const page = await app.firstWindow()
  await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  for (const [index, message] of [
    "PI Lab 1.2 is ready to install on restart.",
    "Updated to PI Lab 1.2",
  ].entries()) {
    await app.evaluate(
      ({ BrowserWindow }, payload) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send("updates:changed", {
          available: true,
          checking: false,
          message: payload.message,
          revision: payload.revision,
        })
      },
      { message, revision: index + 10 },
    )
    await expect(page.getByTestId("update-notice")).toHaveText(message)
    await expect(page.getByTestId("update-notice")).toBeHidden({ timeout: 4500 })
  }
})
