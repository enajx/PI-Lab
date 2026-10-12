import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string
const execFileAsync = promisify(execFile)

let app: ElectronApplication
let dataDir: string
let repoDir: string

/** Launch the production Electron entry against a throwaway workspace. */
test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-search-"))
  repoDir = join(dataDir, "repo")
  await execFileAsync("git", ["init", "-b", "main", repoDir])
  for (const dir of ["src", ".venv", "build", "out", "dist", "unreadable"]) {
    await mkdir(join(repoDir, dir))
    if (dir !== "unreadable") await writeFile(join(repoDir, dir, "sample-target.txt"), dir)
  }
  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: repoDir,
    },
  })
})

test.afterEach(async () => {
  await app?.close()
  if (repoDir) await chmod(join(repoDir, "unreadable"), 0o755)
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("quick-open prunes dependency and output trees and reports an unreadable child", async () => {
  test.skip(process.platform === "win32", "POSIX directory permissions required")
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await chmod(join(repoDir, "unreadable"), 0o000)

  await window.keyboard.press("ControlOrMeta+f")
  await window.getByTestId("quick-open-input").fill("sample-target")
  await expect(window.getByTestId("quick-open-result")).toHaveCount(1)
  await expect(window.getByTestId("quick-open-result")).toHaveAttribute(
    "data-rel-path",
    "src/sample-target.txt",
  )
  await expect(window.getByTestId("quick-open-partial")).toContainText("unreadable")
})
