import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  test,
} from "./fixtures/playwright"

// Menu options show a visible hover highlight in the real app (here: the title bar's
// "Report a bug / Request a feature" menu, in dark mode where it was invisible).

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

let app: ElectronApplication
let dataDir: string

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-menu-hover-"))
  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
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

const background = (locator: Locator) =>
  locator.evaluate((element) => getComputedStyle(element).backgroundColor)

/** Lightness and alpha of a computed `oklch(L C H / A)` colour. */
function oklch(color: string): { lightness: number; alpha: number } {
  const match = /^oklch\(([\d.]+) [\d.]+ [\d.]+(?: \/ ([\d.]+))?\)$/.exec(color)
  if (!match) throw new Error(`Expected an oklch colour, got ${color}`)
  return { lightness: Number(match[1]), alpha: match[2] === undefined ? 1 : Number(match[2]) }
}

test("menu options show a visible hover highlight in dark mode", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.evaluate(() => document.documentElement.classList.add("dark"))

  await window.getByTestId("issue-report-control").click()
  const item = window.getByTestId("issue-report-bug")
  await expect(item).toBeVisible()
  const menuBackground = await background(window.getByTestId("issue-report-menu"))
  const before = await background(item)

  await item.hover()
  // The highlight fades in; wait for it to settle, then compare with the resting item.
  await expect.poll(() => background(item)).not.toBe(before)
  await window.waitForTimeout(300)
  // The colour seen on hover (the highlight over the menu) must stand out from the menu.
  const menu = oklch(menuBackground)
  const hovered = oklch(await background(item))
  const seen = menu.lightness * (1 - hovered.alpha) + hovered.lightness * hovered.alpha
  expect(Math.abs(seen - menu.lightness)).toBeGreaterThanOrEqual(0.08)
  await window
    .getByTestId("issue-report-menu")
    .screenshot({ path: resolve(".cache", "screens", "menu-hover-dark.png") })
})
