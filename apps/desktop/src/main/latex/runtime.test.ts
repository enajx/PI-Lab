import { join } from "node:path"
import { expect, test } from "vitest"
import { resolveLatexRuntime, tectonicCacheDir } from "./runtime"

/** Explicit system selection must report missing tools without selecting bundled Tectonic. */
test("system compiler reports missing PDFLaTeX", async () => {
  await expect(
    resolveLatexRuntime(
      {
        resolveAgentExecutable: async () => null,
        getAgentLaunchEnvironment: async () => ({ PATH: "" }),
        skillsHomeDir: "/missing/pi-lab-runtime-test-home",
      },
      "system",
    ),
  ).rejects.toThrow("PDFLaTeX")
})

/** The package cache sits outside the data folder the Alpha reset archives, except in test mode. */
test("Tectonic cache lives in the per-user OS cache folder, and in the data folder in test mode", () => {
  expect(tectonicCacheDir(false, "/Users/u/.pi-lab-alpha", "darwin", "/Users/u", {})).toBe(
    "/Users/u/Library/Caches/PI Lab/tectonic",
  )
  expect(tectonicCacheDir(false, "/home/u/.pi-lab", "linux", "/home/u", {})).toBe(
    "/home/u/.cache/pi-lab/tectonic",
  )
  expect(
    tectonicCacheDir(false, "/home/u/.pi-lab", "linux", "/home/u", { XDG_CACHE_HOME: "/xdg" }),
  ).toBe("/xdg/pi-lab/tectonic")
  expect(
    tectonicCacheDir(false, "C:/u/.pi-lab", "win32", "C:/u", { LOCALAPPDATA: "C:/u/Local" }),
  ).toBe(join("C:/u/Local", "PI Lab", "tectonic"))
  expect(tectonicCacheDir(true, "/tmp/e2e-root", "darwin", "/Users/u", {})).toBe(
    "/tmp/e2e-root/latex/cache",
  )
})
