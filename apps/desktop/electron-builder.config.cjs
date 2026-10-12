// @ts-check
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: electron-builder expands ${arch} for each target.
/**
 * electron-builder configuration for the PI Lab desktop app (md/engineering/testing-and-build.md (build & ship), P11).
 *
 * This is a `.cjs` (not JSON) so we can *gate code-signing/notarization behind
 * env*: a local developer with no Apple cert must still get a launchable build.
 * When the signing env vars are unset we emit an ad-hoc-signed local build
 * (`identity: "-"`, notarization skipped); when they're set, electron-builder
 * uses the configured Developer ID identity and notarizes.
 *
 * Native modules (`better-sqlite3`, `node-pty`) are the load-bearing concern
 * (AGENTS.md Pitfalls #4): the compiled main bundle does a bare `require("better-sqlite3")`
 * / `require("node-pty")`, and the pty-daemon child (run via ELECTRON_RUN_AS_NODE)
 * loads node-pty's `pty.node` + its sibling `spawn-helper` from disk. Native `.node`
 * files cannot be read from inside an asar archive, so both modules are listed in
 * `asarUnpack` — electron-builder then mirrors them into `app.asar.unpacked/` and
 * patches Node's resolver so the bare requires find the unpacked copies.
 *
 * Layout note: everything the main bundle needs at runtime is reached relative to
 * `out/main` (`../renderer/index.html`, `../preload/index.js`, `../pty-daemon/index.js`,
 * `./drizzle`), so the whole `out/**` tree is packaged preserving that layout.
 */

const SIGN =
  Boolean(process.env.CSC_LINK) ||
  Boolean(process.env.CSC_KEY_PASSWORD) ||
  Boolean(process.env.PI_LAB_FORCE_SIGN)

const NOTARIZE = Boolean(
  process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID,
)

// Keep only compiled app outputs and audited runtime dependencies.
// Put this list inside each platform files array. A global files FileSet plus
// platform-only excludes creates a second permissive app matcher in the builder.
/** @type {string[]} */
const APP_FILES = [
  "out/**",
  "package.json",
  "!**/*.{ts,tsx,map,md}",
  "!**/{test,tests,__tests__,example,examples,docs,doc}/**",
  // These are the emitted main/daemon externals and their runtime dependency
  // tree. validate:package rejects a new external or transitive dependency
  // missing from this list before electron-builder runs.
  "!**/node_modules/!(@jsquash|@trpc|@xterm|better-sqlite3|copy-anything|drizzle-orm|is-what|node-pty|omggif|superjson|trpc-electron|wasm-feature-detect|zod)/**",
  "!**/node_modules/@jsquash/!(webp)/**",
  "!**/node_modules/@trpc/!(server)/**",
  "!**/node_modules/@xterm/!(headless)/**",
  // Keep native runtime libraries and target prebuilds; discard source builds,
  // headers and debug symbols. Per-platform filters below retain matching
  // prebuilds, including Windows ConPTY and winpty helpers.
  "!**/node_modules/{better-sqlite3,node-pty}/{src,deps,scripts}/**",
  "!**/node_modules/{better-sqlite3,node-pty}/binding.gyp",
  "!**/node_modules/{better-sqlite3,node-pty}/build/Debug/**",
  "!**/node_modules/{better-sqlite3,node-pty}/build/Release/{obj.target,.deps}/**",
  "!**/node_modules/{better-sqlite3,node-pty}/**/*.{o,a,pdb,Makefile,mk,gypi}",
  "!**/node_modules/node-addon-api/**",
  "!**/node_modules/node-pty/bin/**",
]

/** @type {import("electron-builder").Configuration} */
const config = {
  appId: "com.pi-lab.desktop",
  productName: "PI Lab",
  // Both native modules use N-API. Validate the installed binaries under Node
  // and Electron before packaging instead of rebuilding or swapping ABIs.
  npmRebuild: false,
  buildDependenciesFromSource: false,
  directories: {
    output: "release",
    buildResources: "build",
  },
  // Native `.node` addons + node-pty's `spawn-helper` executable MUST live outside
  // the asar so they can be dlopen'd / exec'd at runtime.
  asarUnpack: ["**/node_modules/better-sqlite3/**", "**/node_modules/node-pty/**"],
  // Ship the bundled project template alongside the app (exempt from the `files`
  // md/ts exclusion globs) so packaged builds can first-run-seed the writable copy
  // at `<process.resourcesPath>/template`.
  extraResources: [
    { from: "resources/template", to: "template" },
    // Runtime window/Dock/notification identity. `build:icons` copies the
    // canonical `icons/icon.png` here before every package command.
    { from: "build/icon.png", to: "pi-lab-icon.png" },
  ],
  // Keep node-pty's spawn-helper executable bit after it's copied into the package
  // (asar packing can drop it; node-pty exec()s this file for every PTY).
  afterPack: "./scripts/electron-builder-after-pack.cjs",
  mac: {
    files: [
      ...APP_FILES,
      "!**/node_modules/better-sqlite3/prebuilds/!(darwin-${arch}).node",
      "!**/node_modules/node-pty/prebuilds/!(darwin-${arch})/**",
    ],
    // Electron 40 also ships grammatical variants for these same languages.
    electronLanguages: ["en", "en_GB", "zh_CN", "zh_TW", "ko", "ja", "es", "es_419"].flatMap(
      (locale) => [
        locale,
        ...["FEMININE", "MASCULINE", "NEUTER"].map((variant) => `${locale}_${variant}`),
      ],
    ),
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "dir", arch: ["arm64"] },
    ],
    category: "public.app-category.developer-tools",
    icon: "build/icon.icns",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    // Electron's macOS Notification API requires a code-signed application.
    // Ad-hoc signing keeps local packages notification-capable without requiring
    // a Developer ID certificate; distribution builds use the real identity.
    identity: SIGN ? undefined : "-",
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize: NOTARIZE ? { teamId: /** @type {string} */ (process.env.APPLE_TEAM_ID) } : false,
  },
  linux: {
    files: [
      ...APP_FILES,
      "!**/node_modules/better-sqlite3/prebuilds/!(linux-${arch}|linuxmusl-${arch}).node",
      "!**/node_modules/node-pty/prebuilds/!(linux-${arch})/**",
    ],
    electronLanguages: ["en-US", "en-GB", "zh-CN", "zh-TW", "ko", "ja", "es", "es-419"],
    target: [{ target: "AppImage", arch: ["x64", "arm64"] }],
    category: "Development",
    icon: "build/icon.png",
  },
  win: {
    files: [
      ...APP_FILES,
      "!**/node_modules/better-sqlite3/prebuilds/!(win32-${arch}).node",
      "!**/node_modules/node-pty/prebuilds/!(win32-${arch})/**",
    ],
    electronLanguages: ["en-US", "en-GB", "zh-CN", "zh-TW", "ko", "ja", "es", "es-419"],
    target: [{ target: "nsis", arch: ["x64"] }],
    // electron-builder derives the multi-resolution .ico from this png at pack
    // time (we don't generate .ico locally — no Windows tooling on the dev host).
    icon: "build/icon.png",
  },
  // No auto-update / publishing surface (local-only, AGENTS.md "Dropped surfaces" / Pitfalls #6).
  publish: null,
}

module.exports = config
