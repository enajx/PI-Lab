import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

const desktop = join(process.cwd(), "apps/desktop")
const executablePath = createRequire(join(desktop, "package.json"))("electron") as string
let app: ElectronApplication
let dataDir: string

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-window-shortcuts-"))
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
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("Escape returns from Settings to the main view", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })
  await window.keyboard.press("ControlOrMeta+,")
  await expect(window.getByTestId("settings-view")).toBeVisible()
  await window.keyboard.press("ControlOrMeta+p")
  await expect(window.getByTestId("command-palette")).toBeVisible()
  await window.keyboard.press("Escape")
  await expect(window.getByTestId("command-palette")).toHaveCount(0)
  await expect(window.getByTestId("settings-view")).toBeVisible()
  await window.getByTestId("settings-nav-shortcuts").click()
  await window.getByTestId("shortcut-command-palette-rebind").click()
  await window.keyboard.press("ControlOrMeta+p")
  await expect(window.getByTestId("command-palette")).toHaveCount(0)
  await expect(window.getByTestId("shortcut-command-palette-rebind")).toHaveText("Rebind")
  await window.keyboard.press("Escape")
  await expect(window.getByTestId("dashboard")).toBeVisible()
})

test("Cmd+W menu action backgrounds the app without destroying its window", async () => {
  test.skip(process.platform !== "darwin", "macOS app shortcut")
  const window = await app.firstWindow()
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })
  const shortcut = await app.evaluate(({ Menu }) => {
    const items = Menu.getApplicationMenu()?.items.flatMap((item) => item.submenu?.items ?? [])
    const item = items?.find((entry) => entry.accelerator === "Command+W")
    if (!item) return false
    item.click()
    return true
  })
  expect(shortcut).toBe(true)
  await expect.poll(() => app.evaluate(({ app }) => app.isHidden())).toBe(true)
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((win) => !win.isDestroyed()),
    ),
  ).toBe(true)
})

// Verify Chromium drag-region styles and control interaction.
// Actual OS window movement still needs a native pointer drag.
test("central headers drag the window while their controls stay clickable", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })
  for (const collapsed of [false, true]) {
    if (collapsed) await window.getByTestId("sidebar-collapse-toggle").click()
    const header = window.getByTestId("dashboard").locator("header")
    expect(
      await header.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("-webkit-app-region"),
      ),
    ).toBe("drag")
    const caffeine = header.getByTestId("caffeine-control")
    expect(
      await caffeine.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("-webkit-app-region"),
      ),
    ).toBe("no-drag")
    const previous = await caffeine.getAttribute("data-mode")
    await caffeine.click()
    await expect(caffeine).not.toHaveAttribute("data-mode", previous ?? "off")
  }
})
