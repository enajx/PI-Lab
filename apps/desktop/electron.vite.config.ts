import { cpSync, existsSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import { type Plugin, build as viteBuild } from "vite"

/**
 * Copy the generated Drizzle migrations next to the compiled main bundle so the
 * packaged app can find them at `out/main/drizzle`. They live in the bundled
 * `@pi-lab/local-db`, whose source path no longer points anywhere useful once
 * inlined (see src/main/db/migrationsDir.ts).
 */
function copyMigrationsPlugin(): Plugin {
  const from = resolve(__dirname, "..", "..", "packages", "local-db", "drizzle")
  const to = resolve(__dirname, "out", "main", "drizzle")
  return {
    name: "pi-lab:copy-migrations",
    apply: "build",
    closeBundle() {
      if (existsSync(from)) {
        cpSync(from, to, { recursive: true })
      }
    },
  }
}

/**
 * Fourth build (beyond electron-vite's main/preload/renderer): the PTY daemon.
 *
 * electron-vite only knows main/preload/renderer, so we bundle the daemon's
 * entry (`src/main/terminal/daemonEntry.ts`, which drives the reused
 * `@pi-lab/pty-daemon` server) ourselves via a plain Vite library build,
 * triggered from the main build's `closeBundle`. The daemon package's source
 * uses extensionless ESM imports that Node's loader can't resolve from `.ts`, so
 * it MUST be bundled to a single `out/pty-daemon/index.js` the supervisor can run
 * as a detached child.
 *
 * node-pty (a native `.node` addon) is forced external — bundling it would break
 * at runtime — so the daemon `require`s it from node_modules at launch. It is
 * built with N-API; the supervisor runs the daemon under Electron's bundled
 * Node (`ELECTRON_RUN_AS_NODE=1`). Native-load checks validate the addon under
 * both plain Node (unit tests) and Electron (the app and daemon).
 */
function bundlePtyDaemonPlugin(): Plugin {
  const entry = resolve(__dirname, "src", "main", "terminal", "daemonEntry.ts")
  const outDir = resolve(__dirname, "out", "pty-daemon")
  return {
    name: "pi-lab:bundle-pty-daemon",
    apply: "build",
    async closeBundle() {
      await viteBuild({
        configFile: false,
        logLevel: "warn",
        build: {
          outDir,
          minify: "esbuild",
          sourcemap: "hidden",
          emptyOutDir: true,
          ssr: entry,
          target: "node20",
          rollupOptions: {
            external: NATIVE_DEPS_DAEMON,
            output: {
              format: "es",
              entryFileNames: "index.js",
              inlineDynamicImports: true,
            },
          },
        },
      })
      // Mark the emitted `index.js` as ESM so Node loads it without reparsing
      // (the bundle is ES-format; the parent app's package.json is not "module").
      writeFileSync(
        resolve(outDir, "package.json"),
        `${JSON.stringify({ type: "module" }, null, 2)}\n`,
      )
    },
  }
}

/**
 * electron-vite drives three independent builds that share one command, plus the
 * pty-daemon bundle stitched in via the plugin above:
 *
 *   - `main`       → Node/Electron-main bundle    → out/main/index.js
 *   - `preload`    → contextBridge entry          → out/preload/index.js
 *   - `renderer`   → the React web app (Vite)     → out/renderer/index.html
 *   - `pty-daemon` → detachable daemon bundle      → out/pty-daemon/index.js
 *
 * The default outDir is `out/` per build; we set each explicitly so the verify
 * harness and AGENTS.md can rely on the exact paths (`out/main/index.js`).
 *
 * Externalization (main/preload):
 *   - `externalizeDepsPlugin` leaves node_modules deps as runtime `require`s so
 *     native binaries (e.g. `better-sqlite3`, pulled in via `@pi-lab/local-db`)
 *     load from disk instead of being bundled.
 *   - Workspace packages are SOURCE-only TypeScript with extensionless ESM
 *     imports and an `exports` map that points at raw `.ts`; Node's ESM loader
 *     can't resolve those. So every `@pi-lab/*` package main imports at runtime
 *     is BUNDLED here (excluded from externalization) — Vite transpiles their TS
 *     and inlines it. (`@pi-lab/shared` is used by the agent/workspace routers —
 *     `BUILTIN_AGENTS`, `buildLaunchArgv`, `slugify`; `@pi-lab/port-scanner` by
 *     workspace port allocation — `portBaseForSlot`. Left external, their raw-`.ts`
 *     extensionless sub-imports — e.g. `./agents/catalog`, `./allocation` — fail
 *     under Node's ESM loader and the app won't boot. The main process only uses
 *     the daemon's *client* over a socket; if it stayed external, its raw-`.ts`
 *     `./client` import would likewise fail. `@pi-lab/workspace-fs` backs the
 *     `files` router's read/write — same reason it must be bundled.)
 *   - Bundling local-db/pty-daemon would drag their transitive native `.node`
 *     addons in too (`better-sqlite3` via local-db; `node-pty` via the daemon's
 *     server, which main never instantiates), which breaks at runtime, so both are
 *     forced external via `rollupOptions.external`. `drizzle-orm`,
 *     `@pi-lab/shared`, and `@pi-lab/port-scanner` are pure JS and inline fine.
 *   - `trpc-electron` is bundled into the preload because a sandboxed preload
 *     can only `require("electron")`, not arbitrary node_modules.
 */
const WORKSPACE_PACKAGES = [
  "@pi-lab/local-db",
  "@pi-lab/pty-daemon",
  "@pi-lab/shared",
  "@pi-lab/port-scanner",
  "@pi-lab/workspace-fs",
]
/** Native `.node` addons that must stay runtime `require`s, never inlined. */
const NATIVE_DEPS = ["better-sqlite3", "node-pty"]
/** Native addon the daemon bundle must `require` from disk, never inline. */
const NATIVE_DEPS_DAEMON = ["node-pty"]

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES }),
      copyMigrationsPlugin(),
      bundlePtyDaemonPlugin(),
    ],
    build: {
      outDir: "out/main",
      minify: "esbuild",
      sourcemap: "hidden",
      lib: { entry: resolve(__dirname, "src/main/index.ts") },
      rollupOptions: { external: NATIVE_DEPS },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["trpc-electron"] })],
    build: {
      outDir: "out/preload",
      minify: "esbuild",
      sourcemap: "hidden",
      lib: { entry: resolve(__dirname, "src/preload/index.ts") },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    // CodeMirror flattens its extension set with `instanceof` checks that break
    // when more than one copy of its core packages is bundled — the transitive
    // deps of `codemirror` / `@codemirror/lint` / `@replit/codemirror-vim`
    // otherwise resolve to several `@codemirror/state` (and `/view`, `/language`)
    // versions, crashing the editor on mount with "Unrecognized extension value
    // in extension set … multiple instances of @codemirror/state". Force a single
    // instance of each core package so the built-in editor mounts.
    resolve: {
      dedupe: ["@codemirror/state", "@codemirror/view", "@codemirror/lint"],
    },
    plugins: [
      // TanStack Router's file-based codegen MUST run before the React plugin so
      // the generated `routeTree.gen.ts` exists when React transforms the tree.
      // It watches `routes/` in dev and regenerates on each build.
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        routesDirectory: resolve(__dirname, "src/renderer/routes"),
        generatedRouteTree: resolve(__dirname, "src/renderer/routeTree.gen.ts"),
        // Co-located, non-route folders (components/hooks/utils/stores/providers
        // per the repo's project structure) live under `routes/` but are NOT
        // routes. The generator tests this pattern against each entry's *basename*
        // (file or dir), so anchoring the folder names skips the whole subtree —
        // no codegen warnings, co-location preserved.
        routeFileIgnorePattern: "^(components|hooks|utils|stores|providers)$",
      }),
      react(),
      // Tailwind v4 via its first-party Vite plugin — scans the renderer and the
      // shared `@pi-lab/ui` package for utility classes (md/engineering/architecture.md (renderer)).
      tailwindcss(),
    ],
    build: {
      outDir: resolve(__dirname, "out/renderer"),
      minify: "esbuild",
      sourcemap: "hidden",
      rollupOptions: {
        input: [
          resolve(__dirname, "src/renderer/index.html"),
          resolve(__dirname, "src/renderer/quick.html"),
          resolve(__dirname, "src/renderer/tray.html"),
        ],
      },
    },
  },
})
