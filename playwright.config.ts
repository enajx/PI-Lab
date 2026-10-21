import { defineConfig } from "@playwright/test"

// Whole-app checks drive the built Electron application with isolated project data.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  // Packaged channel tests inspect shared app paths and process guards.
  workers: 1,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
})
