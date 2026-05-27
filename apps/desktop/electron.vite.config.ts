import { cpSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import react from "@vitejs/plugin-react"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import type { Plugin } from "vite"

/**
 * Copy the generated Drizzle migrations next to the compiled main bundle so the
 * packaged app can find them at `out/main/drizzle`. They live in the bundled
 * `@skipper/local-db`, whose source path no longer points anywhere useful once
 * inlined (see src/main/db/migrationsDir.ts).
 */
function copyMigrationsPlugin(): Plugin {
  const from = resolve(__dirname, "..", "..", "packages", "local-db", "drizzle")
  const to = resolve(__dirname, "out", "main", "drizzle")
  return {
    name: "skipper:copy-migrations",
    apply: "build",
    closeBundle() {
      if (existsSync(from)) {
        cpSync(from, to, { recursive: true })
      }
    },
  }
}

/**
 * electron-vite drives three independent builds that share one command:
 *
 *   - `main`     → Node/Electron-main bundle      → out/main/index.js
 *   - `preload`  → contextBridge entry            → out/preload/index.js
 *   - `renderer` → the React web app (Vite)       → out/renderer/index.html
 *
 * The default outDir is `out/` per build; we set each explicitly so the verify
 * harness and AGENTS.md can rely on the exact paths (`out/main/index.js`).
 *
 * Externalization (main/preload):
 *   - `externalizeDepsPlugin` leaves node_modules deps as runtime `require`s so
 *     native binaries (e.g. `better-sqlite3`, pulled in via `@skipper/local-db`)
 *     load from disk instead of being bundled.
 *   - Workspace packages are SOURCE-only TypeScript with extensionless ESM
 *     imports and an `exports` map that points at raw `.ts`; Node's ESM loader
 *     can't resolve those. So `@skipper/local-db` is BUNDLED here (excluded from
 *     externalization) — Vite transpiles its TS and inlines it.
 *   - Bundling `@skipper/local-db` would drag its transitive `better-sqlite3`
 *     (a native `.node` addon) in too, which breaks at runtime, so it's forced
 *     external via `rollupOptions.external`. `drizzle-orm` is pure JS and is fine
 *     to bundle.
 *   - `trpc-electron` is bundled into the preload because a sandboxed preload
 *     can only `require("electron")`, not arbitrary node_modules.
 */
const WORKSPACE_PACKAGES = ["@skipper/local-db"]
const NATIVE_DEPS = ["better-sqlite3"]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES }), copyMigrationsPlugin()],
    build: {
      outDir: "out/main",
      lib: { entry: resolve(__dirname, "src/main/index.ts") },
      rollupOptions: { external: NATIVE_DEPS },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["trpc-electron"] })],
    build: {
      outDir: "out/preload",
      lib: { entry: resolve(__dirname, "src/preload/index.ts") },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    build: {
      outDir: resolve(__dirname, "out/renderer"),
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
})
