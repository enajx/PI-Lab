import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  test,
} from "./fixtures/playwright"

// Exercises native SQLite and PTY modules in a packaged app, when available.

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const desktopRequire = createRequire(join(DESKTOP_DIR, "package.json"))
const builderRequire = createRequire(desktopRequire.resolve("electron-builder"))
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib"))
const { listPackage } = appBuilderRequire("@electron/asar") as {
  listPackage: (path: string) => string[]
}

/** The packaged macOS Alpha binary, overridable to check Beta or Stable. */
const PACKAGED_BINARY =
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Packaged smoke target override.
  process.env.PI_LAB_PACKAGED_BINARY ??
  join(
    DESKTOP_DIR,
    "release",
    "alpha",
    "mac-arm64",
    "PI Lab Alpha.app",
    "Contents",
    "MacOS",
    "PI Lab Alpha",
  )
const EXPECTED_CHANNEL_NAME =
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Set alongside the packaged binary for Beta or Stable checks.
  process.env.PI_LAB_EXPECTED_CHANNEL_NAME ?? "PI Lab Alpha"

let app: ElectronApplication
let rootDir: string
let dataDir: string
let repoDir: string

async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", dir])
  const run = (args: string[]) => execFileAsync("git", ["-C", dir, ...args])
  await run(["config", "user.email", "test@pi-lab.local"])
  await run(["config", "user.name", "PI Lab Test"])
  await writeFile(join(dir, "README.md"), "# fixture\n")
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

// Only meaningful once the packaged app exists; otherwise skip (don't fail).
test.skip(
  !existsSync(PACKAGED_BINARY),
  `packaged app not built (run: bun run package) — ${PACKAGED_BINARY}`,
)

test.beforeEach(async () => {
  // The repo sits beside the data dir: a packaged Alpha archives everything in a
  // data dir without its build marker on first launch (db/alphaBuildReset.ts).
  rootDir = await mkdtemp(join(tmpdir(), "pi-lab-pkg-smoke-"))
  dataDir = join(rootDir, "data")
  repoDir = join(rootDir, "repo")
  await mkdir(dataDir)
  await initRepo(repoDir)

  app = await electron.launch({
    // Launch the PACKAGED binary itself — no `args` main entry; the packaged app
    // resolves its own main from its package.json.
    executablePath: PACKAGED_BINARY,
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
  if (rootDir) await rm(rootDir, { recursive: true, force: true })
})

test("packaged ASAR contains only runtime app roots and excludes source/debug maps", () => {
  const archive = join(dirname(PACKAGED_BINARY), "..", "Resources", "app.asar")
  const files = listPackage(archive)
  const roots = [...new Set(files.map((file) => file.split("/").filter(Boolean)[0]))].sort()
  expect(roots).toEqual(["node_modules", "out", "package.json"])
  expect(files.filter((file) => /\.(?:map|ts|tsx)$/u.test(file))).toEqual([])
})

test("packaged app reports its channel identity before the full view opens", async () => {
  const identity = await app.evaluate(({ app: electronApp }) => ({
    name: electronApp.getName(),
    userData: electronApp.getPath("userData"),
  }))
  expect(identity).toEqual({ name: EXPECTED_CHANNEL_NAME, userData: dataDir })
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 60_000 })
})

test("packaged PI Lab.app boots with native modules (better-sqlite3 + node-pty)", async () => {
  const window = await app.firstWindow()

  // Boot gate — reaching this proves DB init + migrate ran (better-sqlite3 loaded
  // under the Electron ABI from app.asar.unpacked).
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 60_000 })

  // The dashboard is the home surface; the opened repo shows as a project card —
  // proving the packaged renderer + main + DB round-trip works.
  await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 60_000 })
  await expect(window.getByTestId("project-card")).toContainText("repo", { timeout: 60_000 })

  // Use the same terminal seam as the development E2E, through this packaged
  // renderer, main process and detached daemon. Keep the child alive until close.
  const marker = "PACKAGED-PTY-OK"
  const terminalUrl = new URL(window.url())
  terminalUrl.searchParams.set("termcmd", process.execPath)
  terminalUrl.searchParams.set(
    "termargs",
    JSON.stringify(["-e", `process.stdout.write('${marker}\\n'); process.stdin.resume()`]),
  )
  await window.goto(terminalUrl.toString())
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 60_000 })
  await expect(window.getByTestId("terminal")).toContainText(marker, { timeout: 30_000 })
})

test("packaged Alpha generates choices from compact icon masters", async () => {
  test.skip(EXPECTED_CHANNEL_NAME !== "PI Lab Alpha", "Alpha icon picker only")
  const resources = join(dirname(PACKAGED_BINARY), "..", "Resources")
  const whiteMasters = await readdir(join(resources, "app-icon-variants"))
  const coloredMasters = await readdir(join(resources, "app-icon-channel-variants"))
  expect(whiteMasters).toHaveLength(68)
  expect(coloredMasters).toHaveLength(68)
  expect(whiteMasters.every((name) => /-viridis(?:-expanded)?\.png$/u.test(name))).toBe(true)
  expect(coloredMasters.every((name) => /-alpha(?:-expanded)?\.png$/u.test(name))).toBe(true)
  expect(await readFile(join(resources, "pi-lab-icon.png"))).toEqual(
    await readFile(join(DESKTOP_DIR, "assets", "icons", "icon-alpha.png")),
  )

  let window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 60_000 })
  await window.getByTestId("nav-settings").click()
  await window.getByTestId("settings-nav-appearance").click()
  const preview = window.getByTestId("settings-app-icon-preview")
  const source = async () => preview.getAttribute("src")
  const changed = async (previous: string | null) => {
    await expect.poll(source).not.toBe(previous)
    const next = await source()
    expect(next).toMatch(/^data:image\/png;base64,/u)
    return next
  }
  await expect(window.getByTestId("settings-app-icon-font")).toHaveValue("gill-sans-regular")
  await expect(window.getByTestId("settings-app-icon-palette")).toHaveValue("viridis")
  await expect(window.getByTestId("settings-app-icon-alpha-white-background")).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  const defaultIcon = await readFile(join(resources, "pi-lab-icon.png"))
  await expect.poll(source).toBe(`data:image/png;base64,${defaultIcon.toString("base64")}`)

  await window.getByTestId("settings-app-icon-family").selectOption("joyplot")
  let previous = await changed(`data:image/png;base64,${defaultIcon.toString("base64")}`)
  await window.getByTestId("settings-app-icon-palette").selectOption("plasma")
  previous = await changed(previous)
  await window.getByTestId("settings-app-icon-reverse").check()
  previous = await changed(previous)
  await window.getByTestId("settings-app-icon-limit-visible-range").check()
  previous = await changed(previous)
  await window.getByTestId("settings-app-icon-alpha-white-background").click()
  await changed(previous)
  await window.getByTestId("settings-app-icon-favorite").click()
  await expect(window.getByTestId("settings-app-icon-favorites").locator("option")).toHaveCount(2)

  await app.close()
  app = await electron.launch({
    executablePath: PACKAGED_BINARY,
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
    },
  })
  window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 60_000 })
  await window.getByTestId("nav-settings").click()
  await window.getByTestId("settings-nav-appearance").click()
  await expect(window.getByTestId("settings-app-icon-family")).toHaveValue("joyplot")
  await expect(window.getByTestId("settings-app-icon-palette")).toHaveValue("plasma")
  await expect(window.getByTestId("settings-app-icon-reverse")).toBeChecked()
  await expect(window.getByTestId("settings-app-icon-limit-visible-range")).toBeChecked()
  await expect(window.getByTestId("settings-app-icon-alpha-white-background")).toHaveAttribute(
    "aria-pressed",
    "false",
  )
  await expect(window.getByTestId("settings-app-icon-preview")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/u,
  )
})

test("packaged public app keeps its release icon and hides icon choices", async () => {
  test.skip(EXPECTED_CHANNEL_NAME !== "PI Lab", "Public app package only")
  const resources = join(dirname(PACKAGED_BINARY), "..", "Resources")
  const version = await app.evaluate(({ app }) => app.getVersion())
  const icon = version.includes("-beta.") ? "icon-beta.png" : "icon.png"
  expect(await readFile(join(resources, "pi-lab-icon.png"))).toEqual(
    await readFile(join(DESKTOP_DIR, "assets", "icons", icon)),
  )
  expect(existsSync(join(resources, "app-icon-variants"))).toBe(false)
  expect(existsSync(join(resources, "app-icon-channel-variants"))).toBe(false)
  expect(existsSync(join(resources, "app-icon-palettes.json"))).toBe(false)

  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 60_000 })
  await window.getByTestId("nav-settings").click()
  await window.getByTestId("settings-nav-appearance").click()
  await expect(window.getByTestId("settings-app-icon-family")).toHaveCount(0)
  const choice = await window.evaluate(async () => {
    const bridge = (
      globalThis as typeof globalThis & {
        piLab?: { appIcon?: { get: () => Promise<{ piFont: string; piPalette: string }> } }
      }
    ).piLab?.appIcon
    if (!bridge) throw new Error("app icon bridge is unavailable")
    return bridge.get()
  })
  expect(choice).toMatchObject({ piFont: "gill-sans-regular", piPalette: "gray-30" })
})
