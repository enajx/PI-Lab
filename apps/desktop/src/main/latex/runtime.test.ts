import { expect, test } from "vitest"
import { resolveLatexRuntime } from "./runtime"

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
