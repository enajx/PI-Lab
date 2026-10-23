import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { createMenuBarIconService } from "./trayVisibility"

test("the menu-bar icon stays visible despite an older saved hidden choice", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-lab-menu-bar-"))
  writeFileSync(join(dataDir, "menu-bar-icon-hidden"), "")
  const service = createMenuBarIconService("darwin")
  expect(service.get()).toEqual({ visible: true, available: false })
  expect(() => service.set(false)).toThrow("always visible")
  expect(service.set(true)).toEqual({ visible: true, available: false })
  rmSync(dataDir, { recursive: true })
})
