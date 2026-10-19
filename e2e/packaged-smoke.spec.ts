import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

/**
 * Packaged-app smoke (git history (build phases) P11 / AGENTS.md Pitfalls #4): launch the REAL packaged
 * `PI Lab.app`, assert the database round-trip, then receive real PTY output.
 *
 * This is the only test that proves native modules load from the *packaged* app:
 * better-sqlite3 (DB init + migrate on boot) and node-pty (its `.node` +
 * `spawn-helper` in `app.asar.unpacked`) must resolve via the real app's
 * asar-aware resolver. The PTY assertion opens the daemon's real native path;
 * boot alone only proves the SQLite path.
 *
 * It's GATED on the packaged Alpha build existing (`release/alpha/mac-arm64/PI Lab Alpha.app`) and
 * skips otherwise, so it never breaks `bun run e2e` on a checkout that only ran
 * `bun run build`. Build it with `bun run package` (or `--cwd apps/desktop package`).
 *
 * MUST run under Node (not Bun) — Playwright's `_electron` launcher hangs under
 * the Bun runtime (md/engineering/testing-and-build.md (build & ship)).
 */

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "apps", "desktop")
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
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-pkg-smoke-"))
  repoDir = join(dataDir, "repo")
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
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
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

test("packaged icon choices use bundled resources and reopen with the saved selection", async () => {
  test.skip(EXPECTED_CHANNEL_NAME !== "PI Lab", "Stable keeps the configurable color palette")
  const resources = join(dirname(PACKAGED_BINARY), "..", "Resources")
  const previewMatches = async (
    window: Awaited<ReturnType<ElectronApplication["firstWindow"]>>,
    name: string,
  ) => {
    const expected = await readFile(join(resources, name))
    await expect
      .poll(async () => {
        const source = await window.getByTestId("settings-app-icon-preview").getAttribute("src")
        if (!source?.startsWith("data:image/png;base64,")) return false
        return Buffer.from(source.slice("data:image/png;base64,".length), "base64").equals(expected)
      })
      .toBe(true)
  }
  expect(await readFile(join(resources, "pi-lab-icon.png"))).toEqual(
    await readFile(join(DESKTOP_DIR, "..", "..", "icons", "icon.png")),
  )

  let window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 60_000 })
  await app.evaluate(({ app: electronApp }) => {
    const dock = electronApp.dock
    if (!dock) return
    const original = dock.setIcon.bind(dock)
    const probe = globalThis as typeof globalThis & { __piLabDockIconCalls?: string[] }
    probe.__piLabDockIconCalls = []
    dock.setIcon = (icon) => {
      if (typeof icon === "string") probe.__piLabDockIconCalls?.push(icon)
      original(icon)
    }
  })
  await window.getByTestId("nav-settings").click()
  await window.getByTestId("settings-nav-appearance").click()
  await expect(window.getByTestId("settings-app-icon-style")).toHaveValue("25")
  await expect(window.getByTestId("settings-app-icon-palette")).toHaveValue("magma")
  await expect(window.getByTestId("settings-app-icon-expanded")).toBeChecked()
  await expect(window.getByTestId("settings-app-icon-limit-visible-range")).not.toBeChecked()
  await previewMatches(window, "pi-lab-icon.png")
  await window.getByTestId("settings-app-icon-family").selectOption("pi")
  await expect(window.getByTestId("settings-app-icon-font")).toHaveValue("helvetica-neue-medium")
  await expect(window.getByTestId("settings-app-icon-preview")).toHaveAttribute(
    "alt",
    "Pi Lab helvetica-neue-medium, Viridis",
  )
  await previewMatches(window, "app-icon-variants/pi-helvetica-neue-medium-viridis.png")
  await expect
    .poll(() =>
      window
        .getByTestId("settings-app-icon-preview")
        .evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0)
  await window.getByTestId("settings-app-icon-family").selectOption("joyplot")
  await expect(
    window.getByTestId("settings-app-icon-style").locator("option[value='16']"),
  ).toHaveCount(0)
  await expect(
    window.getByTestId("settings-app-icon-style").locator("option[value='23']"),
  ).toHaveCount(0)
  const theme = window.getByTestId("settings-app-icon-palette")
  await theme.click()
  await theme.press("ArrowDown")
  await expect(theme).toHaveValue("magma-iris")
  await previewMatches(window, "app-icon-variants/joyplot-25-magma-iris-expanded.png")
  await theme.press("Escape")
  const favorite = window.getByTestId("settings-app-icon-favorite")
  let favorites = window.getByTestId("settings-app-icon-favorites")
  await favorite.click()
  await expect(favorite).toHaveAttribute("aria-pressed", "true")
  await expect(favorites.locator("option")).toHaveCount(2)

  await theme.selectOption("viridis")
  await expect(favorite).toHaveAttribute("aria-pressed", "false")
  await window.getByTestId("settings-app-icon-reverse").check()
  await previewMatches(window, "app-icon-variants/joyplot-25-viridis-reversed-expanded.png")
  await window.getByTestId("settings-app-icon-limit-visible-range").check()
  await previewMatches(window, "app-icon-variants/joyplot-25-viridis-reversed-limited-expanded.png")
  await favorite.click()
  await expect(favorites.locator("option")).toHaveCount(3)
  await expect(favorites.locator("option").nth(1)).toContainText("Viridis")
  await expect(favorites.locator("option").nth(1)).toContainText("Reversed")
  await expect(favorites.locator("option").nth(1)).toContainText("Limited range")
  await expect
    .poll(() =>
      app.evaluate(() =>
        (
          globalThis as typeof globalThis & { __piLabDockIconCalls?: string[] }
        ).__piLabDockIconCalls?.at(-1),
      ),
    )
    .toMatch(/joyplot-25-viridis-reversed-limited-expanded\.png$/)

  await window.getByTestId("settings-app-icon-family").selectOption("pi")
  await expect(window.getByTestId("settings-app-icon-reverse")).not.toBeChecked()
  await expect(window.getByTestId("settings-app-icon-limit-visible-range")).not.toBeChecked()
  await expect(favorite).toHaveAttribute("aria-pressed", "false")
  const font = window.getByTestId("settings-app-icon-font")
  await font.click()
  await font.press("ArrowDown")
  await expect(font).toHaveValue("gill-sans-regular")
  await previewMatches(window, "app-icon-variants/pi-gill-sans-regular-viridis.png")
  await font.press("Escape")
  await window.getByTestId("settings-app-icon-palette").selectOption("plasma")
  await window.getByTestId("settings-app-icon-reverse").check()
  await window.getByTestId("settings-app-icon-limit-visible-range").check()
  await previewMatches(window, "app-icon-variants/pi-gill-sans-regular-plasma-reversed-limited.png")
  await favorite.click()
  await expect(favorites.locator("option")).toHaveCount(4)
  await expect(favorites.locator("option").nth(1)).toContainText("Pi Lab")
  await expect(favorites.locator("option").nth(1)).toContainText("Gill Sans")

  await window.getByTestId("settings-app-icon-family").selectOption("joyplot")
  await expect(window.getByTestId("settings-app-icon-reverse")).toBeChecked()
  await expect(window.getByTestId("settings-app-icon-limit-visible-range")).toBeChecked()
  await window.getByTestId("settings-app-icon-reverse").uncheck()
  await theme.selectOption("magma")
  const style = window.getByTestId("settings-app-icon-style")
  await style.click()
  await style.press("ArrowDown")
  await expect(style).toHaveValue("26")
  await previewMatches(window, "app-icon-variants/joyplot-26-magma-limited-expanded.png")
  await style.press("Escape")
  await window.getByTestId("settings-app-icon-style").selectOption("37")
  await previewMatches(window, "app-icon-variants/joyplot-37-magma-limited-expanded.png")
  await expect
    .poll(() =>
      window
        .getByTestId("settings-app-icon-preview")
        .evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0)
  await window.getByTestId("settings-app-icon-style").selectOption("52")
  await window.getByTestId("settings-app-icon-palette").selectOption("viridis")
  await previewMatches(window, "app-icon-variants/joyplot-52-viridis-limited-expanded.png")
  await expect(window.getByTestId("settings-app-icon-style").locator("option")).toHaveCount(28)
  await expect(theme.locator("option")).toHaveCount(70)
  await expect
    .poll(async () => JSON.parse(await readFile(join(dataDir, "app-icon-selection.json"), "utf8")))
    .toMatchObject({
      family: "joyplot",
      joyplotStyle: "52",
      joyplotPalette: "viridis",
      joyplotExpanded: true,
      joyplotReverse: false,
      joyplotLimitVisibleRange: true,
      piFont: "gill-sans-regular",
      piPalette: "plasma",
      piReverse: true,
      piLimitVisibleRange: true,
      favoriteIcons: [
        {
          family: "pi",
          font: "gill-sans-regular",
          palette: "plasma",
          reverse: true,
          limitVisibleRange: true,
        },
        {
          family: "joyplot",
          style: "25",
          palette: "viridis",
          expanded: true,
          reverse: true,
          limitVisibleRange: true,
        },
        {
          family: "joyplot",
          style: "25",
          palette: "magma-iris",
          expanded: true,
          reverse: false,
          limitVisibleRange: false,
        },
      ],
    })

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
  favorites = window.getByTestId("settings-app-icon-favorites")
  await expect(window.getByTestId("settings-app-icon-style")).toHaveValue("52")
  await expect(window.getByTestId("settings-app-icon-expanded")).toBeChecked()
  await expect(window.getByTestId("settings-app-icon-limit-visible-range")).toBeChecked()
  await previewMatches(window, "app-icon-variants/joyplot-52-viridis-limited-expanded.png")
  await expect(window.getByTestId("settings-app-icon-favorite")).toHaveAttribute(
    "aria-pressed",
    "false",
  )
  await window.getByTestId("settings-app-icon-family").selectOption("pi")
  await expect(window.getByTestId("settings-app-icon-font")).toHaveValue("gill-sans-regular")
  await expect(window.getByTestId("settings-app-icon-palette")).toHaveValue("plasma")
  await expect(window.getByTestId("settings-app-icon-reverse")).toBeChecked()
  await expect(window.getByTestId("settings-app-icon-limit-visible-range")).toBeChecked()
  await previewMatches(window, "app-icon-variants/pi-gill-sans-regular-plasma-reversed-limited.png")
  await favorites.selectOption("1")
  await expect(window.getByTestId("settings-app-icon-family")).toHaveValue("joyplot")
  await expect(window.getByTestId("settings-app-icon-style")).toHaveValue("25")
  await expect(window.getByTestId("settings-app-icon-palette")).toHaveValue("viridis")
  await expect(window.getByTestId("settings-app-icon-reverse")).toBeChecked()
  await expect(window.getByTestId("settings-app-icon-limit-visible-range")).toBeChecked()
  await previewMatches(window, "app-icon-variants/joyplot-25-viridis-reversed-limited-expanded.png")
  await expect(window.getByTestId("settings-app-icon-favorite")).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await favorites.selectOption("2")
  await expect(window.getByTestId("settings-app-icon-palette")).toHaveValue("magma-iris")
  await expect(window.getByTestId("settings-app-icon-reverse")).not.toBeChecked()
  await expect(window.getByTestId("settings-app-icon-limit-visible-range")).not.toBeChecked()
  await previewMatches(window, "app-icon-variants/joyplot-25-magma-iris-expanded.png")
})
