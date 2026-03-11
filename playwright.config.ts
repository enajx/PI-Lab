import { defineConfig } from "@playwright/test"

// Whole-app E2E driving the real Electron build via `_electron.launch()` (AGENTS.md §14).
// Specs land from P3 once the shell boots; the `verify` smoke harness reuses this setup.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
})
