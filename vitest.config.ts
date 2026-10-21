import { defineConfig } from "vitest/config"

// Main-process tests use Node; renderer tests use jsdom.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: [
            "packages/*/src/**/*.test.ts",
            "apps/desktop/src/main/**/*.test.ts",
            "apps/desktop/scripts/**/*.test.ts",
          ],
        },
      },
      {
        test: {
          name: "renderer-unit",
          environment: "jsdom",
          include: ["apps/desktop/src/renderer/**/*.test.{ts,tsx}"],
          setupFiles: ["apps/desktop/src/renderer/test/setup.ts"],
        },
      },
    ],
  },
})
