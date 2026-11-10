import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { latexEngineName, resolveLatexRuntime, tectonicCacheDir } from "./runtime"

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

/** A folder holding an executable stand-in for bundled Tectonic, for the current platform. */
function fakeTectonic(): { resources: string; cache: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-lab-tectonic-"))
  const resources = join(root, "resources")
  const folder = join(resources, `${process.platform}-${process.arch}`)
  mkdirSync(folder, { recursive: true })
  const path = join(folder, process.platform === "win32" ? "tectonic.exe" : "tectonic")
  writeFileSync(path, "#!/bin/sh\n")
  chmodSync(path, 0o755)
  return { resources, cache: join(root, "cache") }
}

/** Auto uses system pdflatex + latexmk when both are found. */
test("auto compiler uses system LaTeX when it is installed", async () => {
  const tectonic = fakeTectonic()
  const runtime = await resolveLatexRuntime(
    {
      resolveAgentExecutable: async (name) => `/tex/bin/${name}`,
      getAgentLaunchEnvironment: async () => ({ PATH: "/tex/bin" }),
      skillsHomeDir: "/missing/pi-lab-runtime-test-home",
      latexResourcesDir: tectonic.resources,
      latexCacheDir: tectonic.cache,
    },
    "auto",
  )
  expect(runtime).toMatchObject({
    provider: "system",
    executable: "/tex/bin/latexmk",
    pdflatexPath: "/tex/bin/pdflatex",
  })
})

/** Auto falls back to bundled Tectonic when no system LaTeX is found. */
test("auto compiler uses bundled Tectonic when system LaTeX is missing", async () => {
  const tectonic = fakeTectonic()
  const runtime = await resolveLatexRuntime(
    {
      resolveAgentExecutable: async () => null,
      getAgentLaunchEnvironment: async () => ({ PATH: "" }),
      skillsHomeDir: "/missing/pi-lab-runtime-test-home",
      latexResourcesDir: tectonic.resources,
      latexCacheDir: tectonic.cache,
    },
    "auto",
  )
  expect(runtime).toMatchObject({ provider: "bundled", cacheDir: tectonic.cache })
})

/** Auto with neither engine names both missing engines. */
test("auto compiler reports when no LaTeX engine is available", async () => {
  await expect(
    resolveLatexRuntime(
      {
        resolveAgentExecutable: async () => null,
        getAgentLaunchEnvironment: async () => ({ PATH: "" }),
        skillsHomeDir: "/missing/pi-lab-runtime-test-home",
      },
      "auto",
    ),
  ).rejects.toThrow("No LaTeX engine is available")
})

/** Explicit bundled selection never uses system LaTeX, even when it is installed. */
test("bundled compiler does not fall back to system LaTeX", async () => {
  await expect(
    resolveLatexRuntime(
      {
        resolveAgentExecutable: async (name) => `/tex/bin/${name}`,
        getAgentLaunchEnvironment: async () => ({ PATH: "/tex/bin" }),
        skillsHomeDir: "/missing/pi-lab-runtime-test-home",
      },
      "bundled",
    ),
  ).rejects.toThrow("Tectonic")
})

/** The footer names a system LaTeX by its distribution and year when pdflatex reports it. */
test("names system LaTeX from the pdflatex version line", () => {
  expect(latexEngineName("system", "pdfTeX 3.141592653-2.6-1.40.29 (TeX Live 2026/Homebrew)")).toBe(
    "TeX Live 2026",
  )
  expect(latexEngineName("system", "MiKTeX-pdfTeX 4.19 (MiKTeX 24.4)")).toBe("MiKTeX")
  expect(latexEngineName("system", null)).toBe("System LaTeX")
  expect(latexEngineName("bundled", "Tectonic 0.15.0")).toBe("Tectonic")
})
