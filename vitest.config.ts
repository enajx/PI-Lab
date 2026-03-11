import { defineConfig } from "vitest/config"

// Root Vitest config. Each package/layer runs under its own project + environment
// (see AGENTS.md §14). Component tests (Vitest Browser Mode) are added at P7 when the
// first renderer component lands.
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["packages/*/src/**/*.test.ts", "apps/desktop/src/main/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "renderer-unit",
          environment: "jsdom",
          include: ["apps/desktop/src/renderer/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
})
