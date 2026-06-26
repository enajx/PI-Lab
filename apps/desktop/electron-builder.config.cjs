// @ts-check
/**
 * electron-builder configuration for the Skipper desktop app (docs/testing-and-build.md (build & ship), P11).
 *
 * This is a `.cjs` (not JSON) so we can *gate code-signing/notarization behind
 * env*: a local developer with no Apple cert must still get a launchable build.
 * When the signing env vars are unset we emit an UNSIGNED build (`identity: null`,
 * notarization skipped); when they're set, electron-builder signs + notarizes.
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
  Boolean(process.env.SKIPPER_FORCE_SIGN)

const NOTARIZE = Boolean(
  process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID,
)

/** @type {import("electron-builder").Configuration} */
const config = {
  appId: "com.skipper.desktop",
  productName: "Skipper",
  // Avoid rebuilding native deps via node-gyp during packaging — we drive the
  // Electron-ABI rebuild ourselves (@electron/rebuild) in the build scripts so
  // the ABI is explicit and validated (validate:native).
  npmRebuild: false,
  buildDependenciesFromSource: false,
  directories: {
    output: "release",
    buildResources: "build",
  },
  // What lands inside the app. The compiled `out/**` tree carries main/preload/
  // renderer/pty-daemon + the copied drizzle migrations. The native modules are
  // pulled in via node_modules (electron-builder copies production deps); we keep
  // them and explicitly drop the source-only workspace packages (already inlined
  // into `out/**` by electron-vite) and the prebuilt-but-unused node-pty variants.
  files: [
    "out/**",
    "package.json",
    "!**/*.{ts,tsx,map,md}",
    "!**/{test,tests,__tests__,example,examples,docs,doc}/**",
    // node-pty ships prebuilds for every platform + a node-gyp-build `bin/` copy;
    // only `build/Release` is loaded (see node-pty utils.js) — `setup:native` seeds
    // it from the macOS prebuild / Linux builds it from source — so trim the rest to
    // keep the package lean and the loaded ABI unambiguous.
    "!**/node_modules/node-pty/prebuilds/**",
    "!**/node_modules/node-pty/bin/**",
    "!**/node_modules/node-pty/build/Release/{obj.target,.deps}/**",
  ],
  // Native `.node` addons + node-pty's `spawn-helper` executable MUST live outside
  // the asar so they can be dlopen'd / exec'd at runtime.
  asarUnpack: ["**/node_modules/better-sqlite3/**", "**/node_modules/node-pty/**"],
  // Ship the bundled project template alongside the app (exempt from the `files`
  // md/ts exclusion globs) so packaged builds can first-run-seed the writable copy
  // at `<process.resourcesPath>/template`. NB: copying through `extraResources` may
  // dereference the `CLAUDE.md` -> `AGENTS.md` symlink in the packaged copy —
  // verify the seeded copy still writes CLAUDE.md through to AGENTS.md on macOS.
  extraResources: [{ from: "resources/template", to: "template" }],
  // Keep node-pty's spawn-helper executable bit after it's copied into the package
  // (asar packing can drop it; node-pty exec()s this file for every PTY).
  afterPack: "./scripts/electron-builder-after-pack.cjs",
  mac: {
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "dir", arch: ["arm64"] },
    ],
    category: "public.app-category.developer-tools",
    icon: "build/icon.icns",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    // Gate signing on env: unsigned (identity:null) locally, real identity in CI
    // when a cert is provided. `identity: null` makes electron-builder ad-hoc /
    // skip signing instead of failing on a missing cert.
    identity: SIGN ? undefined : null,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize: NOTARIZE ? { teamId: /** @type {string} */ (process.env.APPLE_TEAM_ID) } : false,
  },
  linux: {
    target: [{ target: "AppImage", arch: ["x64", "arm64"] }],
    category: "Development",
    icon: "build/icon.png",
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    // electron-builder derives the multi-resolution .ico from this png at pack
    // time (we don't generate .ico locally — no Windows tooling on the dev host).
    icon: "build/icon.png",
  },
  // No auto-update / publishing surface (local-only, AGENTS.md "Dropped surfaces" / Pitfalls #6).
  publish: null,
}

module.exports = config
