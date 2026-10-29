import { defineConfig } from "@playwright/test"

// Whole-app checks drive the built Electron application with isolated project data.
export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./.cache/test-results",
  // Stop app, helper, and pty-daemon processes left by an interrupted run.
  globalSetup: "./tests/support/e2eGlobalSetup.ts",
  globalTeardown: "./tests/support/e2eGlobalTeardown.ts",
  fullyParallel: false,
  // Packaged channel tests inspect shared app paths and process guards.
  workers: 1,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
})
