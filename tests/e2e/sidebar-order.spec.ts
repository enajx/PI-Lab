import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { _electron as electron, expect, test } from "./fixtures/playwright"

/** Actual sidebar drag order persists across a renderer reload. */
test("sidebar uses the new default order and preserves user reordering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-sidebar-order-"))
  const desktop = join(process.cwd(), "apps/desktop")
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional packaged verification.
  const binary = process.env.PI_LAB_PACKAGED_BINARY
  const app = await electron.launch({
    executablePath: binary ?? createRequire(join(desktop, "package.json"))("electron"),
    args: binary ? [] : [join(desktop, "out/main/index.js")],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dir,
      PI_LAB_SOCKET_PATH: join(dir, "daemon.sock"),
    },
  })
  try {
    const page = await app.firstWindow()
    const nav = page.getByTestId("science-nav")
    const order = () =>
      nav
        .locator("[data-science-tab]")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-science-tab")))
    // The Editor row is hidden by default, so it is not in the list.
    const defaults = ["tasks", "library", "analysis", "latex", "skills", "workflows", "cluster"]
    await expect.poll(order).toEqual(defaults)
    await nav
      .locator('[data-science-tab="cluster"]')
      .dragTo(nav.locator('[data-science-tab="tasks"]'), { targetPosition: { x: 20, y: 2 } })
    const custom = ["cluster", ...defaults.slice(0, -1)]
    await expect.poll(order).toEqual(custom)
    await page.reload()
    await expect.poll(order).toEqual(custom)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

/** Right-clicking a view entry hides it; the menu's list shows it again, also after a reload. */
test("sidebar view entries hide and show from the right-click menu", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-sidebar-menu-"))
  const desktop = join(process.cwd(), "apps/desktop")
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Optional packaged verification.
  const binary = process.env.PI_LAB_PACKAGED_BINARY
  const app = await electron.launch({
    executablePath: binary ?? createRequire(join(desktop, "package.json"))("electron"),
    args: binary ? [] : [join(desktop, "out/main/index.js")],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dir,
      PI_LAB_SOCKET_PATH: join(dir, "daemon.sock"),
    },
  })
  try {
    const page = await app.firstWindow()
    const nav = page.getByTestId("science-nav")
    const library = nav.locator('[data-science-tab="library"]')
    const menu = page.getByTestId("sidebar-view-menu")
    await expect(library).toBeVisible()

    await library.click({ button: "right" })
    await expect(menu).toBeVisible()
    await expect(page.getByTestId("sidebar-view-menu-hide")).toHaveText("Hide 'Library'")
    await expect(menu).not.toContainText("Dashboard")
    await page.getByTestId("sidebar-view-menu-hide").click()
    await expect(menu).toBeHidden()
    await expect(library).toHaveCount(0)

    await page.reload()
    await expect(nav.locator('[data-science-tab="tasks"]')).toBeVisible()
    await expect(library).toHaveCount(0)

    await nav.locator('[data-science-tab="tasks"]').click({ button: "right" })
    const libraryEntry = menu.getByRole("menuitemcheckbox", { name: "Library" })
    await expect(libraryEntry).toHaveAttribute("aria-checked", "false")
    await expect(menu.getByRole("menuitemcheckbox", { name: "Tasks" })).toHaveAttribute(
      "aria-checked",
      "true",
    )
    await page.screenshot({ path: resolve(".cache", "screens", "sidebar-menu.png") })
    await libraryEntry.click()
    await expect(menu).toBeHidden()
    await expect(library).toBeVisible()

    await nav.locator('[data-science-tab="tasks"]').click({ button: "right" })
    await expect(menu).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(menu).toBeHidden()
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
