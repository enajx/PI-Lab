import { defineConfig } from "vitest/config"

/**
 * Server bundle tests (`bun run test:bundle`): they build the server bundle
 * from `apps/desktop/out/` (run `bun run build` first), install it into temp
 * folders and run it under the bundle's own Node. No Electron, no windows.
 * Slow, so they are not part of `bun run test`.
 */
export default defineConfig({
  test: {
    name: "bundle",
    environment: "node",
    include: ["tests/bundle/**/*.test.ts"],
    setupFiles: ["tests/support/gitTestEnv.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
})
