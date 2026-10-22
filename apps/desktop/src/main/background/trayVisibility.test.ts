import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { createMenuBarIconService } from "./trayVisibility"

test("menu-bar icon choice persists across app starts and can be restored", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-lab-menu-bar-"))
  try {
    const first = createMenuBarIconService(() => dataDir, "darwin")
    expect(first.get()).toEqual({ visible: true, available: true })
    first.set(false)
    expect(createMenuBarIconService(() => dataDir, "darwin").get()).toEqual({
      visible: false,
      available: true,
    })
    first.set(true)
    expect(createMenuBarIconService(() => dataDir, "darwin").get()).toEqual({
      visible: true,
      available: true,
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
