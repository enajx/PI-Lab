import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"
import type { AppIconBridge } from "../../apps/desktop/src/shared/appIcon"
import { APP_ICON_DEFAULT_SELECTION } from "../../apps/desktop/src/shared/appIcon"

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "desktop")
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
    const baselinePreview = await bridge.preview({
      ...current,
      family: "pi",
      piFont: "didot-bold",
      piPalette: "viridis",
    })
    const chosen = await bridge.set({
      ...current,
      family: "pi",
      piFont: "didot-bold",
      piPalette: "plasma",
    })
    return {
      channel,
      palette: chosen.piPalette,
      preview: await bridge.preview(chosen),
      baselinePreview,
    }
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
      readFileSync(join(desktop, "assets", "icons", "icon-alpha.png")),
    )
    const alphaIcon = await choosePackagedPiIcon(alphaWindow)
    expect(alphaIcon.channel).toBe("alpha")
    expect(alphaIcon.palette).toBe("plasma")
    expect(alphaIcon.preview).not.toBe(alphaIcon.baselinePreview)
    expect(Buffer.from(alphaIcon.baselinePreview.split(",")[1] ?? "", "base64")).toEqual(
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
    for (const [window, palette] of [[alphaWindow, "plasma"]] as const) {
      await window.getByRole("button", { name: "Open PI Lab" }).click()
      await window.locator("header").getByRole("button", { name: "Skip setup" }).click()
      await expect(window.getByTestId("quick-editor-full-app")).toBeVisible({ timeout: 30_000 })
      await window.getByTestId("nav-settings").click()
      await window.getByTestId("settings-nav-appearance").click()
      await expect(window.getByTestId("settings-app-icon-family")).toHaveValue("pi")
      await expect(window.getByTestId("settings-app-icon-font")).toHaveValue("didot-bold")
      await expect(window.getByTestId("settings-app-icon-palette")).toHaveValue(palette)
      await expect(window.getByTestId("settings-app-icon-palette")).toBeEnabled()
      expect(
        await window.getByTestId("settings-app-icon-palette").locator("option").count(),
      ).toBeGreaterThan(1)
    }
  } finally {
    await stable?.close()
    await alpha?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("public Beta keeps its fixed icon despite an older saved choice", async () => {
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
    JSON.stringify({ ...APP_ICON_DEFAULT_SELECTION, family: "joyplot", joyplotPalette: "viridis" }),
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
    const choice = await window.evaluate(async () => {
      const bridge = (globalThis as typeof globalThis & { piLab?: { appIcon?: AppIconBridge } })
        .piLab?.appIcon
      if (!bridge) throw new Error("packaged app icon bridge is unavailable")
      const selection = await bridge.get()
      const previewRejected = await bridge.preview(selection).then(
        () => false,
        () => true,
      )
      const setRejected = await bridge.set(selection).then(
        () => false,
        () => true,
      )
      return { selection, previewRejected, setRejected }
    })
    expect(choice.selection).toMatchObject({
      family: "pi",
      piFont: "gill-sans-regular",
      piPalette: "gray-30",
    })
    expect(choice.previewRejected).toBe(true)
    expect(choice.setRejected).toBe(true)
    const finderIcon = join(dirname(dirname(publicBetaBinary)), "Resources", "pi-lab-icon.png")
    expect(readFileSync(finderIcon)).toEqual(
      readFileSync(join(desktop, "assets", "icons", "icon-beta.png")),
    )
  } finally {
    await beta?.close()
    await rm(root, { recursive: true, force: true })
  }
})
