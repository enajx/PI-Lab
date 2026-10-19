import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

/**
 * Whole-app E2E: launch the real Electron build, boot to
 * `app-ready`, navigate to the Library science tab, and prove it is wired — with
 * a fresh (unconfigured) data dir the **library source chooser** renders its three
 * sources (Zotero local, Zotero cloud, folder). We do NOT exercise the live Zotero API
 * or the native folder dialog here (no network / no driveable native dialog in E2E); the
 * router's fetch + folder-read paths are covered by the integration suite.
 *
 * MUST run under Node (not Bun) — Playwright's `_electron` launcher hangs under
 * Bun; the repo `e2e` script runs Playwright's CLI through node.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

let app: ElectronApplication
let dataDir: string

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-library-"))

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

test("library tab shows the source chooser (three sources) when unconfigured", async () => {
  const window = await app.firstWindow()

  // Boot gate.
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  // Navigate to the Library science tab via the sidebar nav.
  const libraryNav = window.locator('[data-testid="science-nav-item"][data-science-tab="library"]')
  await expect(libraryNav).toBeVisible({ timeout: 30_000 })
  await libraryNav.click()

  // The tab renders.
  await expect(window.getByTestId("science-library")).toBeVisible({ timeout: 30_000 })

  // A fresh data dir has no stored connection, so the source chooser shows — the Zotero
  // local + cloud cards and the folder card.
  await expect(window.getByTestId("library-source-chooser")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("zotero-chooser-local")).toBeVisible()
  await expect(window.getByTestId("zotero-chooser-web")).toBeVisible()
  await expect(window.getByTestId("library-source-folder")).toBeVisible()

  // The Cloud card reveals the API key form on demand.
  await window.getByTestId("zotero-use-web").click()
  await expect(window.getByTestId("zotero-api-key-input")).toBeVisible()
  await expect(window.getByTestId("zotero-connect-submit")).toBeVisible()
})
