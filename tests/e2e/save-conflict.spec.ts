import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "./fixtures/playwright"
import { processAlive, readServerDiscovery } from "./fixtures/serverClient"

/**
 * Done check "Save conflict" (step 1 plan, PR 2): open a file, let an agent
 * change it, press Save: the unsaved text is kept and the conflict is shown.
 * Lose the server while editing: the buffer stays, marked "not saved", and a
 * later Save writes it. Built app in test mode, real server and filesystem;
 * the "agent" is a plain file write from the test.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string
const FILE = "notes.md"

const execFileAsync = promisify(execFile)

let app: ElectronApplication
let dataDir: string
let repoDir: string

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-save-conflict-"))
  repoDir = join(dataDir, "repo")
  await execFileAsync("git", ["init", "-b", "main", repoDir])
  const run = (args: string[]) => execFileAsync("git", ["-C", repoDir, ...args])
  await run(["config", "user.email", "test@pi-lab.local"])
  await run(["config", "user.name", "PI Lab Test"])
  await writeFile(join(repoDir, FILE), "opened text\n")
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
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
  const discovery = readServerDiscovery(dataDir)
  if (discovery && processAlive(discovery.pid)) process.kill(discovery.pid, "SIGTERM")
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

/** Open the fixture file and type at its end. */
async function openAndType(window: Page, text: string): Promise<void> {
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("project-item").click()
  await window.getByTestId("panel-tab-files").click()
  await window.getByTestId("file-tree-file").filter({ hasText: FILE }).click()
  const buffer = window.getByTestId("editor-buffer")
  await buffer.locator(".cm-content").click()
  await window.keyboard.press("ControlOrMeta+End")
  await window.keyboard.type(text)
}

test("Save after an agent changed the file keeps the unsaved text and shows the conflict", async () => {
  const window = await app.firstWindow()
  await openAndType(window, "MY-UNSAVED-TEXT")
  // The agent edits the file, then the user presses Save before the editor polls.
  await writeFile(join(repoDir, FILE), "agent edit\n")
  await window.keyboard.press("ControlOrMeta+S")

  await expect(window.getByTestId("editor-external-warning")).toBeVisible()
  await expect(window.getByTestId("editor-buffer")).toContainText("MY-UNSAVED-TEXT")
  expect(await readFile(join(repoDir, FILE), "utf8")).toBe("agent edit\n")

  await window.getByRole("button", { name: "Overwrite disk", exact: true }).click()
  await expect.poll(() => readFile(join(repoDir, FILE), "utf8")).toContain("MY-UNSAVED-TEXT")
  await expect(window.getByTestId("editor-external-warning")).toHaveCount(0)
})

test("a Save while the server is unreachable keeps the buffer, marked not saved", async () => {
  test.setTimeout(120_000)
  const window = await app.firstWindow()
  await openAndType(window, "TYPED-OFFLINE")
  const before = readServerDiscovery(dataDir)
  if (!before) throw new Error("no server.json")
  process.kill(before.pid, "SIGKILL")
  await expect.poll(() => processAlive(before.pid), { timeout: 10_000 }).toBe(false)

  await window.keyboard.press("ControlOrMeta+S")
  await expect(window.getByTestId("central-tab-not-saved")).toBeVisible({ timeout: 15_000 })
  await expect(window.getByTestId("editor-buffer")).toContainText("TYPED-OFFLINE")
  expect(await readFile(join(repoDir, FILE), "utf8")).toBe("opened text\n")

  // The server comes back (as launchd would restart it); the queued save goes through.
  const serverEntry = join(DESKTOP_DIR, "out", "main", "server.js")
  const restarted = spawn(ELECTRON_PATH, [serverEntry], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PI_LAB_TEST_MODE: "1",
      PI_LAB_CHANNEL: "alpha",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_PROFILE_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_PACKAGED: "0",
      PI_LAB_RESOURCES_DIR: join(DESKTOP_DIR, "resources"),
      PI_LAB_BUILD: createHash("sha256")
        .update(readFileSync(serverEntry))
        .digest("hex")
        .slice(0, 16),
      PI_LAB_VERSION: "0.0.0",
      PI_LAB_SERVER_PORT: "0",
    },
  })
  restarted.unref()
  await expect
    .poll(() => readFile(join(repoDir, FILE), "utf8"), { timeout: 30_000 })
    .toContain("TYPED-OFFLINE")
  await expect(window.getByTestId("central-tab-not-saved")).toHaveCount(0)
  await expect(window.getByTestId("central-tab-dirty")).toHaveCount(0)
})
