import { defineConfig } from "vitest/config"

/** Tests for the phone app's plain TypeScript logic (src/logic), in Node. */
export default defineConfig({
  test: { environment: "node", include: ["src/logic/**/*.test.ts"] },
})
