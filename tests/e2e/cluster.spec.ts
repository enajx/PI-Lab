import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  test,
} from "./fixtures/playwright"

/**
 * Whole-app E2E: launch the real Electron build, boot to
 * `app-ready`, navigate to the Cluster science tab, and prove it is wired end to
 * end — machines imported from a **fixture ssh-config** (seeded via the
 * `?sshConfigPath` test seam, NOT the real `~/.ssh/config`) appear as cards with
 * the hide affordance.
 *
 * MUST run under Node (not Bun) — Playwright's `_electron` launcher hangs under
 * Bun.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

const SSH_CONFIG_FIXTURE = `
Host gpu-box
  HostName 10.0.0.5
  User researcher
  Port 2222

Host laptop
  HostName laptop.local
  User ada

Host *
  ServerAliveInterval 60
`

let app: ElectronApplication
let dataDir: string
let sshConfigPath: string

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-cluster-"))
  sshConfigPath = join(dataDir, "ssh-config")
  await writeFile(sshConfigPath, SSH_CONFIG_FIXTURE)

  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      // Seed the Cluster tab from the fixture ssh-config (not the real one).
      PI_LAB_TEST_SSH_CONFIG: sshConfigPath,
    },
  })
})

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("cluster tab imports machines from a fixture ssh-config", async () => {
  const window = await app.firstWindow()

  // Boot gate.
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  // Navigate to the Cluster science tab via the sidebar nav.
  const clusterNav = window.locator('[data-testid="science-nav-item"][data-science-tab="cluster"]')
  await expect(clusterNav).toBeVisible({ timeout: 30_000 })
  await clusterNav.click()

  // The tab renders.
  await expect(window.getByTestId("science-cluster")).toBeVisible({ timeout: 30_000 })

  // The `?sshConfigPath` seam imports the fixture's two concrete hosts (the
  // wildcard `Host *` is skipped), so two cards appear.
  const cards = window.getByTestId("machine-card")
  await expect(cards).toHaveCount(2, { timeout: 30_000 })

  // The imported hosts are present, and each card carries the hide toggle.
  await expect(window.locator('[data-testid="machine-card"][data-host="gpu-box"]')).toBeVisible()
  await expect(window.locator('[data-testid="machine-card"][data-host="laptop"]')).toBeVisible()
  await expect(window.getByTestId("toggle-hidden").first()).toBeVisible()

  // Cluster uses the same shared resize primitive, with its own 280px base;
  // all cards remain uniform and the old scalar slider is gone.
  await expect(window.getByTestId("cluster-card-size")).toHaveCount(0)
  await expect(window.getByTestId("cluster-grid")).toHaveAttribute(
    "data-card-grid-base-column",
    "280",
  )
  await expect(window.getByTestId("cluster-grid")).toHaveAttribute("data-card-grid-scale", "1")
  const firstItem = window.getByTestId("machine-card-drag").first()
  await expect(firstItem).toHaveAttribute("data-card-span", "1x1")
  await window.getByTestId("card-resize-handle").first().focus()
  await window.keyboard.press("ArrowDown")
  await expect(window.getByTestId("cluster-grid")).toHaveAttribute("data-card-grid-scale", "1.05")
  await expect(firstItem).toHaveAttribute("data-card-span", "1x1")
})
