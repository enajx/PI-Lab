import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { onePagePdf } from "./fixtures/pdf"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  test,
} from "./fixtures/playwright"

// Checks the Library source chooser in the real Electron build.

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
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
  // For comparison with the LaTeX Editor setup page (latex-setup-cards.png), which uses the same layout.
  await window.screenshot({ path: resolve(".cache", "screens", "library-setup.png") })

  // The Cloud card reveals the API key form on demand.
  await window.getByTestId("zotero-use-web").click()
  await expect(window.getByTestId("zotero-api-key-input")).toBeVisible()
  await expect(window.getByTestId("zotero-connect-submit")).toBeVisible()
})

test("library: type to filter, Escape goes up, Enter opens a PDF in a viewer tab", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  // A folder library: papers/methods/alpha.pdf and papers/results/beta.pdf.
  const root = join(dataDir, "papers")
  await mkdir(join(root, "methods"), { recursive: true })
  await mkdir(join(root, "results"), { recursive: true })
  await writeFile(join(root, "methods", "alpha.pdf"), onePagePdf("Alpha paper text"))
  await writeFile(join(root, "results", "beta.pdf"), onePagePdf("Beta paper text"))
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, root)

  await window.locator('[data-testid="science-nav-item"][data-science-tab="library"]').click()
  await window.getByTestId("library-source-folder-pick").click()
  await expect(window.getByTestId("library-type-hint")).toHaveText(
    "papers: type to navigate library",
  )
  await expect(window.getByTestId("library-collection")).toHaveCount(2)

  // Typing filters this level; no ⌘F finder opens.
  await window.keyboard.type("mth")
  await expect(window.getByTestId("library-type-query")).toContainText("mth")
  await expect(window.getByTestId("library-collection")).toHaveCount(1)
  await expect(window.getByTestId("library-collection")).toContainText("methods")
  await expect(window.getByTestId("quick-find")).toHaveCount(0)

  // Enter drills in; Enter on the paper opens it in a viewer tab on the right.
  await window.keyboard.press("Enter")
  await expect(window.getByTestId("library-item")).toHaveCount(1)

  // Escape in the ⌘F finder only closes the finder; the view stays in "methods".
  await window.keyboard.press("Meta+f")
  await expect(window.getByTestId("quick-find")).toBeVisible()
  await window.keyboard.press("Escape")
  await expect(window.getByTestId("quick-find")).toHaveCount(0)
  await expect(window.getByTestId("library-breadcrumb")).toContainText("methods")
  await expect(window.getByTestId("library-item")).toHaveCount(1)
  await expect(window.getByTestId("library-list-pane")).not.toHaveAttribute("data-split", "true")
  await window.keyboard.press("Enter")
  const viewer = window.getByTestId("library-viewer")
  await expect(viewer.locator(".textLayer").first()).toContainText("Alpha paper text", {
    timeout: 30_000,
  })
  await expect(window.getByTestId("library-list-pane")).toHaveAttribute("data-split", "true")
  await window.screenshot({ path: resolve(".cache", "screens", "library-viewer.png") })

  // Escape goes back to the parent folder; the tab stays open.
  await window.keyboard.press("Escape")
  await expect(window.getByTestId("library-all-items")).toBeVisible()
  await expect(window.getByTestId("library-viewer-tab")).toHaveCount(1)

  // A second paper opens a second tab; closing both returns to the centered layout.
  await window.getByTestId("library-collection").filter({ hasText: "results" }).click()
  await window.getByTestId("library-item").click()
  await expect(viewer.locator(".textLayer").first()).toContainText("Beta paper text", {
    timeout: 30_000,
  })
  await expect(window.getByTestId("library-viewer-tab")).toHaveCount(2)
  await window.getByTestId("library-viewer-tab-close").first().click()
  await window.getByTestId("library-viewer-tab-close").first().click()
  await expect(viewer).toHaveCount(0)
  await expect(window.getByTestId("library-list-pane")).not.toHaveAttribute("data-split", "true")
})
