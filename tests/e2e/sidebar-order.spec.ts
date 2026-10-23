import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _electron as electron, expect, test } from "@playwright/test"

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
    const defaults = ["editor", "analysis", "tasks", "library", "skills", "workflows", "cluster"]
    await expect.poll(order).toEqual(defaults)
    await nav
      .locator('[data-science-tab="cluster"]')
      .dragTo(nav.locator('[data-science-tab="editor"]'), { targetPosition: { x: 20, y: 2 } })
    const custom = ["cluster", ...defaults.slice(0, -1)]
    await expect.poll(order).toEqual(custom)
    await page.reload()
    await expect.poll(order).toEqual(custom)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
