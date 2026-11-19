import { mkdtemp, rm, stat } from "node:fs/promises"
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
 * Checks the "Protect saved keys with Keychain" switch through the real app and
 * server. In test mode the server uses a file, `<dataDir>/test-keychain.json`,
 * as a stand-in for the macOS Keychain, so this does not touch the real
 * Keychain. Playwright's Electron launcher must run under Node, not Bun.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

// biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional packaged Alpha verification.
const packagedBinary = process.env.PI_LAB_PACKAGED_BINARY

let app: ElectronApplication
let dataDir: string

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-secret-"))
  app = await electron.launch({
    executablePath: packagedBinary ?? ELECTRON_PATH,
    args: packagedBinary ? [] : [MAIN_ENTRY],
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

test("Keychain switch moves the key out of secrets.key and back", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  const keyFile = join(dataDir, "secrets.key")
  const keychainFile = join(dataDir, "test-keychain.json")

  await window.getByTestId("nav-settings").click()
  await window.getByTestId("settings-nav-agents").click()
  const toggle = window.getByTestId("settings-secret-protection")
  await expect(toggle).toBeEnabled({ timeout: 30_000 })
  await expect(toggle).toHaveAttribute("aria-checked", "false")

  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 30_000 })
  await expect.poll(() => exists(keychainFile)).toBe(true)
  expect(await exists(keyFile)).toBe(false)

  // The window comes back in Settings on the General page after a reload.
  await window.reload()
  await window.getByTestId("settings-nav-agents").click()
  const afterReload = window.getByTestId("settings-secret-protection")
  await expect(afterReload).toHaveAttribute("aria-checked", "true", { timeout: 30_000 })

  await afterReload.click()
  await expect(afterReload).toHaveAttribute("aria-checked", "false", { timeout: 30_000 })
  await expect.poll(() => exists(keyFile)).toBe(true)
  expect((await stat(keyFile)).mode & 0o777).toBe(0o600)
})
