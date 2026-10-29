import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _electron as electron, expect, test } from "./fixtures/playwright"

/** Exercise the real macOS font scan through Electron, IPC, and the Settings picker. */
test("Editor discovers real macOS fonts and keeps the selected family", async () => {
  test.skip(process.platform !== "darwin", "macOS system font discovery")
  test.setTimeout(90_000)
  const desktop = join(process.cwd(), "apps/desktop")
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional packaged-app target for this direct Playwright check.
  const binary = process.env.PI_LAB_PACKAGED_BINARY
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-real-fonts-"))
  const app = await electron.launch({
    executablePath: binary ?? createRequire(join(desktop, "package.json"))("electron"),
    args: binary ? [] : [join(desktop, "out/main/index.js")],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_TEST_FONT_FAMILIES: "",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
    },
  })
  try {
    const window = await app.firstWindow()
    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await window.getByTestId("nav-settings").click()
    await window.getByTestId("settings-nav-editor").click()
    const family = window.getByTestId("settings-editor-font-family")
    await expect(family.locator('option[value="Menlo"]')).toHaveCount(1, { timeout: 65_000 })
    await expect(family.locator('option[value="Gill Sans"]')).toHaveCount(1)
    await expect(
      window.getByText("System fonts could not be detected.", { exact: false }),
    ).toHaveCount(0)
    await family.selectOption("Menlo")
    await window.getByTestId("settings-back").click()
    await window.getByTestId("nav-settings").click()
    await window.getByTestId("settings-nav-editor").click()
    await expect(family).toHaveValue("Menlo")
    console.log(
      `Real macOS picker contains ${(await family.locator("option").count()) - 1} families`,
    )
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
