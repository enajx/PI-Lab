import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"
import type { AppIconBridge } from "../apps/desktop/src/shared/appIcon"
import { APP_ICON_DEFAULT_SELECTION } from "../apps/desktop/src/shared/appIcon"

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "desktop")
const alphaBinary = join(
  desktop,
  "release",
  "alpha",
  "mac-arm64",
  "PI Lab Alpha.app",
  "Contents",
  "MacOS",
  "PI Lab Alpha",
)
const stableBinary = join(
  desktop,
  "release",
  "stable",
  "mac-arm64",
  "PI Lab.app",
  "Contents",
  "MacOS",
  "PI Lab",
)
const guard = join(desktop, "scripts", "assert-package-output-idle.cjs")
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Packaged Beta test target override.
const publicBetaBinary = process.env.PI_LAB_PACKAGED_BINARY

/** Use the real preload and main-process icon handler in a packaged Quick Editor window. */
async function choosePackagedPiIcon(window: import("@playwright/test").Page) {
  return window.evaluate(async () => {
    const bridge = (globalThis as typeof globalThis & { piLab?: { appIcon?: AppIconBridge } }).piLab
      ?.appIcon
    if (!bridge) throw new Error("packaged app icon bridge is unavailable")
    const channel = await bridge.getChannel()
    const current = await bridge.get()
    const chosen = await bridge.set({
      ...current,
      family: "pi",
      piFont: "didot-bold",
      piPalette: "plasma",
    })
    return { channel, palette: chosen.piPalette, preview: await bridge.preview(chosen) }
  })
}

/** Run the same process guard used before channel packaging. */
function packageGuard(channel: "alpha" | "stable") {
  return spawnSync(process.execPath, [guard], {
    cwd: desktop,
    env: { ...process.env, PI_LAB_CHANNEL: channel },
    encoding: "utf8",
  })
}

test("packaged Alpha and PI Lab run together with separate default state", async () => {
  test.skip(!existsSync(alphaBinary) || !existsSync(stableBinary), "Build Alpha and PI Lab first")
  test.setTimeout(120_000)
  const root = await mkdtemp(join(tmpdir(), "pi-lab-channels-"))
  const home = join(root, "home")
  await mkdir(home)
  const file = join(root, "sample.py")
  await writeFile(file, "print(1 + 2)\n")
  const env = { ...process.env, HOME: home }
  delete env.PI_LAB_DATA_DIR
  delete env.PI_LAB_TEST_MODE
  let alpha: ElectronApplication | null = null
  let stable: ElectronApplication | null = null
  try {
    alpha = await electron.launch({ executablePath: alphaBinary, args: [file], env })
    const alphaWindow = await alpha.firstWindow()
    await expect(alphaWindow.getByTestId("quick-editor")).toBeVisible({ timeout: 30_000 })
    expect(packageGuard("alpha").stderr).toContain("PI Lab is running from")
    const resources = join(
      desktop,
      "release",
      "alpha",
      "mac-arm64",
      "PI Lab Alpha.app",
      "Contents",
      "Resources",
    )
    expect(readFileSync(join(resources, "pi-lab-icon.png"))).toEqual(
      readFileSync(join(desktop, "..", "..", "icons", "icon-alpha.png")),
    )
    const alphaIcon = await choosePackagedPiIcon(alphaWindow)
    expect(alphaIcon.channel).toBe("alpha")
    expect(alphaIcon.palette).toBe("viridis")
    expect(Buffer.from(alphaIcon.preview.split(",")[1] ?? "", "base64")).toEqual(
      readFileSync(
        join(
          desktop,
          "release",
          "alpha",
          "mac-arm64",
          "PI Lab Alpha.app",
          "Contents",
          "Resources",
          "app-icon-channel-variants",
          "pi-didot-bold-alpha.png",
        ),
      ),
    )
    stable = await electron.launch({ executablePath: stableBinary, args: [file], env })
    const stableWindow = await stable.firstWindow()
    await expect(stableWindow.getByTestId("quick-editor")).toBeVisible({ timeout: 30_000 })
    expect(packageGuard("stable").stderr).toContain("PI Lab is running from")
    expect(
      await alpha.evaluate(({ app }) => ({
        name: app.getName(),
        userData: app.getPath("userData"),
      })),
    ).toEqual({ name: "PI Lab Alpha", userData: join(home, ".pi-lab-alpha") })
    await expect
      .poll(() => existsSync(join(home, ".pi-lab-alpha", "local.db")), { timeout: 60_000 })
      .toBe(true)
    await expect
      .poll(() => existsSync(join(home, ".pi-lab", "local.db")), { timeout: 60_000 })
      .toBe(true)
    for (const [window, palette] of [[alphaWindow, "viridis"]] as const) {
      await window.getByRole("button", { name: "Open PI Lab" }).click()
      await window.locator("header").getByRole("button", { name: "Skip setup" }).click()
      await expect(window.getByTestId("quick-editor-full-app")).toBeVisible({ timeout: 30_000 })
      await window.getByTestId("nav-settings").click()
      await window.getByTestId("settings-nav-appearance").click()
      await expect(window.getByTestId("settings-app-icon-family")).toHaveValue("pi")
      await expect(window.getByTestId("settings-app-icon-font")).toHaveValue("didot-bold")
      await expect(window.getByTestId("settings-app-icon-palette")).toHaveValue(palette)
      await expect(window.getByTestId("settings-app-icon-palette")).toBeDisabled()
      await expect(window.getByTestId("settings-app-icon-palette").locator("option")).toHaveCount(1)
    }
  } finally {
    await stable?.close()
    await alpha?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("public Beta uses the shared icon color without changing its signed Finder icon", async () => {
  test.skip(!publicBetaBinary || !existsSync(publicBetaBinary), "Set PI_LAB_PACKAGED_BINARY")
  if (!publicBetaBinary) return
  test.setTimeout(60_000)
  const root = await mkdtemp(join(tmpdir(), "pi-lab-public-beta-"))
  const data = join(root, "data")
  await mkdir(data)
  const file = join(root, "sample.py")
  await writeFile(file, "print(1 + 2)\n")
  await writeFile(
    join(data, "app-icon-selection.json"),
    JSON.stringify({ ...APP_ICON_DEFAULT_SELECTION, joyplotPalette: "viridis" }),
  )
  let beta: ElectronApplication | null = null
  try {
    beta = await electron.launch({
      executablePath: publicBetaBinary,
      args: [file],
      env: { ...process.env, PI_LAB_DATA_DIR: data, PI_LAB_TEST_MODE: "1" },
    })
    const window = await beta.firstWindow()
    await expect(window.getByTestId("quick-editor")).toBeVisible({ timeout: 30_000 })
    const preview = await window.evaluate(async () => {
      const bridge = (globalThis as typeof globalThis & { piLab?: { appIcon?: AppIconBridge } })
        .piLab?.appIcon
      if (!bridge) throw new Error("packaged app icon bridge is unavailable")
      const selection = await bridge.get()
      const source = await bridge.preview(selection)
      const image = new Image()
      image.src = source
      await image.decode()
      const canvas = document.createElement("canvas")
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext("2d")
      if (!context) throw new Error("canvas unavailable")
      context.drawImage(image, 0, 0)
      const pixel = [...context.getImageData(128, 30, 1, 1).data]
      return { palette: selection.joyplotPalette, pixel }
    })
    expect(preview.palette).toBe("viridis")
    expect(preview.pixel[1]).toBeGreaterThan(preview.pixel[0] ?? 255)
    const finderIcon = join(dirname(dirname(publicBetaBinary)), "Resources", "pi-lab-icon.png")
    expect(readFileSync(finderIcon)).toEqual(
      readFileSync(join(desktop, "..", "..", "icons", "icon-beta.png")),
    )
  } finally {
    await beta?.close()
    await rm(root, { recursive: true, force: true })
  }
})
