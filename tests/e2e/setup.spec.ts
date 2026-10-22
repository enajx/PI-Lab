import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

let app: ElectronApplication | null = null
let dataDir = ""

async function launch(): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_TEST_FIRST_RUN: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
    },
  })
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-setup-"))
  app = await launch()
})

test.afterEach(async () => {
  await app?.close()
  app = null
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("first launch finishes with Silent, stays complete after restart, and can reopen manually", async () => {
  if (!app) throw new Error("Electron app did not launch")
  let window = await app.firstWindow()

  await expect(window.getByTestId("first-run-setup")).toBeVisible({ timeout: 30_000 })
  if (process.platform === "darwin") {
    const titleLeft = await window
      .getByRole("heading", { name: "Set up PI Lab" })
      .evaluate((heading) => heading.getBoundingClientRect().left)
    expect(titleLeft).toBeGreaterThanOrEqual(96)
  }
  await expect(window.getByTestId("dashboard")).toHaveCount(0)
  await expect(window.getByLabel("Completion sound")).toHaveValue("silent")
  await window.getByRole("button", { name: "Finish setup" }).click()
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })

  await app.close()
  app = await launch()
  window = await app.firstWindow()
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("first-run-setup")).toHaveCount(0)

  await window.keyboard.press("ControlOrMeta+p")
  await window.getByTestId("command-palette-input").fill("Run first-launch setup")
  const command = window.locator('[data-command-id="open-first-run-setup"]')
  await expect(command).toBeVisible()
  await command.click()
  await expect(window.getByTestId("first-run-setup")).toBeVisible({ timeout: 30_000 })
})

test("first-launch setup is skippable", async () => {
  if (!app) throw new Error("Electron app did not launch")
  const window = await app.firstWindow()

  await expect(window.getByTestId("first-run-setup")).toBeVisible({ timeout: 30_000 })
  await window.getByRole("button", { name: "Skip setup" }).first().click()
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("first-run-setup")).toHaveCount(0)
})

test("language selection persists through setup and can change in Settings", async () => {
  if (!app) throw new Error("Electron app did not launch")
  const window = await app.firstWindow()
  await expect(window.getByTestId("first-run-setup")).toBeVisible({ timeout: 30_000 })
  await window.getByLabel("Language").selectOption("es")
  await expect(window.getByRole("heading", { name: "Configurar PI Lab" })).toBeVisible()
  await window.getByRole("button", { name: "Finalizar configuración" }).click()
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })

  await window.keyboard.press("ControlOrMeta+p")
  await window.getByTestId("command-palette-input").fill("Ir a Biblioteca")
  await expect(window.locator('[data-command-id="nav-library"]')).toBeVisible()
  await window.keyboard.press("Escape")

  await window.locator('[data-science-tab="tasks"]').click()
  await expect(window.getByRole("heading", { name: "Tareas" })).toBeVisible()
  await expect(window.getByRole("button", { name: "Nueva tarea" })).toBeVisible()
  await expect(window.getByText("No se encontraron tareas")).toBeVisible()

  await window.keyboard.press("ControlOrMeta+Comma")
  await expect(window.getByTestId("settings-interface-language")).toHaveValue("es")
  await window.getByTestId("settings-interface-language").selectOption("ar")
  await expect(window.locator("html")).toHaveAttribute("dir", "rtl")
  await expect(window.getByText("السلوك العام للتطبيق.")).toBeVisible()

  await app.close()
  app = await launch()
  const reopened = await app.firstWindow()
  await expect(reopened.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })
  await expect(reopened.locator("html")).toHaveAttribute("lang", "ar")
  const sidebar = await reopened.getByTestId("app-sidebar").boundingBox()
  const resizeHandle = await reopened.getByTestId("sidebar-edge-drag").boundingBox()
  const viewportWidth = await reopened.evaluate(() => window.innerWidth)
  expect(sidebar).not.toBeNull()
  expect(resizeHandle).not.toBeNull()
  expect(Math.abs((sidebar?.x ?? 0) + (sidebar?.width ?? 0) - viewportWidth)).toBeLessThan(4)
  expect(Math.abs((resizeHandle?.x ?? 0) - (sidebar?.x ?? 0))).toBeLessThan(4)
  await reopened.keyboard.press("ControlOrMeta+Comma")
  await expect(reopened.getByTestId("settings-interface-language")).toHaveValue("ar")
})
