// @ts-check
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: electron-builder expands ${arch} for each target.
/**
 * electron-builder configuration for the PI Lab desktop app.
 *
 * Local builds use an ad-hoc signature when no signing identity is requested.
 * Production public builds require a Developer ID identity and notarization.
 * Notarization accepts a Keychain profile or Apple ID credentials.
 *
 * Native modules (`better-sqlite3`, `node-pty`) need special packaging:
 * the compiled main bundle does a bare `require("better-sqlite3")`
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

const { join } = require("node:path")
// Customize the staging image before normal DMG compression, signing and update metadata.
process.env.CUSTOM_DMGBUILD_PATH = join(__dirname, "scripts/dmg-background.cjs")

const { channelDefinition } = require("./scripts/package-channel.cjs")
const { publicReleaseDefinition, publicUpdateUrl } = require("./scripts/public-release.cjs")
const publicReleaseChannel = process.env.PI_LAB_PUBLIC_RELEASE_CHANNEL
const publicRelease = publicReleaseChannel
  ? publicReleaseDefinition(publicReleaseChannel, process.env.PI_LAB_RELEASE_VERSION)
  : null
const testPublicRelease = process.env.PI_LAB_UPDATE_TEST_BUILD === "1"
const SIGN =
  Boolean(publicRelease && !testPublicRelease) ||
  Boolean(process.env.CSC_LINK) ||
  Boolean(process.env.CSC_KEY_PASSWORD) ||
  Boolean(process.env.PI_LAB_FORCE_SIGN)
const NOTARIZE = Boolean(
  (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) ||
    (process.env.APPLE_KEYCHAIN && process.env.APPLE_KEYCHAIN_PROFILE),
)
const { channel, productName, appId } = publicRelease
  ? channelDefinition("stable")
  : channelDefinition(process.env.PI_LAB_CHANNEL)
const iconChannel = publicRelease?.iconChannel ?? channel
const updateUrl =
  publicRelease && testPublicRelease
    ? publicUpdateUrl(process.env.PI_LAB_UPDATE_URL, testPublicRelease)
    : null

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
  "!**/node_modules/!(@jsquash|@trpc|@xterm|argparse|better-sqlite3|builder-util-runtime|copy-anything|debug|drizzle-orm|electron-updater|fs-extra|graceful-fs|is-what|js-yaml|jsonfile|lazy-val|lodash.escaperegexp|lodash.isequal|ms|node-pty|omggif|sax|semver|superjson|tiny-typed-emitter|trpc-electron|universalify|wasm-feature-detect|zod)/**",
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
  appId,
  productName,
  ...(publicRelease ? { artifactName: "PI-Lab-${version}-${arch}.${ext}" } : {}),
  extraMetadata: {
    piLabChannel: channel,
    ...(publicRelease
      ? {
          piLabPublicRelease: true,
          piLabReleaseChannel: publicRelease.channel,
          version: publicRelease.version,
        }
      : {}),
  },
  ...(publicRelease
    ? { generateUpdatesFilesForAllChannels: false, forceCodeSigning: !testPublicRelease }
    : {}),
  fileAssociations:
    channel === "stable"
      ? [
          {
            ext: [
              "txt",
              "md",
              "py",
              "pyi",
              "cpp",
              "cc",
              "cxx",
              "c",
              "h",
              "hpp",
              "hxx",
              "js",
              "ts",
              "tsx",
              "jsx",
              "json",
              "yaml",
              "yml",
              "toml",
              "sh",
              "rs",
            ],
            name: "Text source file",
            role: "Editor",
            rank: "Alternate",
          },
        ]
      : [],
  // Both native modules use N-API. Validate the installed binaries under Node
  // and Electron before packaging instead of rebuilding or swapping ABIs.
  npmRebuild: false,
  buildDependenciesFromSource: false,
  directories: {
    // Direct electron-builder invocations stay away from each channel alias.
    output:
      process.env.PI_LAB_PACKAGE_STAGE ||
      (publicRelease
        ? `release/.direct-public-${publicRelease.channel}`
        : `release/.direct-${channel}`),
    buildResources: "build",
  },
  // Native `.node` addons + node-pty's `spawn-helper` executable MUST live outside
  // the asar so they can be dlopen'd / exec'd at runtime.
  asarUnpack: ["**/node_modules/better-sqlite3/**", "**/node_modules/node-pty/**"],
  extraResources: [
    { from: "assets/dmg/background.tiff", to: "dmg-background.tiff" },
    { from: "resources", to: ".", filter: ["skills/**/*"] },
    { from: "resources/Credits.html", to: "Credits.html" },
    { from: "resources/latex", to: "latex", filter: ["manifest.json", "LICENSE", "NOTICE"] },
    { from: "resources/bin/pilab", to: "bin/pilab" },
    // Runtime window/Dock/notification identity. `build:icons` stages the
    // selected channel icon here before every package command.
    { from: "build/icon.png", to: "pi-lab-icon.png" },
    { from: "assets/icons/trayTemplate.png", to: "trayTemplate.png" },
    { from: "assets/icons/trayTemplate@2x.png", to: "trayTemplate@2x.png" },
    ...(iconChannel === "alpha"
      ? [
          {
            from: "assets/icons/matplotlib-colormaps-3.11.2.json",
            to: "app-icon-palettes.json",
          },
        ]
      : []),
    ...(iconChannel === "alpha"
      ? [
          {
            from: "src/renderer/routes/_shell/settings/components/AppIconGallery/channel-icons",
            to: "app-icon-channel-variants",
            filter: ["joyplot-*-alpha.png", "joyplot-*-alpha-expanded.png", "pi-*-alpha.png"],
          },
        ]
      : []),
    ...(iconChannel === "alpha"
      ? [
          {
            from: "src/renderer/routes/_shell/settings/components/AppIconGallery/icons",
            to: "app-icon-variants",
            filter: ["joyplot-*-viridis.png", "joyplot-*-viridis-expanded.png", "pi-*-viridis.png"],
          },
        ]
      : []),
  ],
  // Keep node-pty's spawn-helper executable bit after it's copied into the package
  // (asar packing can drop it; node-pty exec()s this file for every PTY).
  beforePack: async (context) => {
    await require("./scripts/electron-builder-before-pack.cjs").default(context)
    await require("./scripts/prepare-latex-runtime.cjs").prepareForPack(context)
  },
  afterPack: "./scripts/electron-builder-after-pack.cjs",
  mac: {
    // Modern macOS uses the flat catalog; older systems retain icon.icns.
    extraResources: [
      { from: "build/Assets.car", to: "Assets.car" },
      { from: "resources/latex/darwin-${arch}", to: "latex/darwin-${arch}" },
    ],
    extendInfo: {
      CFBundleIconName: "AppIcon",
      ...(channel === "stable"
        ? {
            CFBundleDocumentTypes: [
              {
                CFBundleTypeName: "Plain text",
                CFBundleTypeRole: "Editor",
                LSHandlerRank: "Alternate",
                LSItemContentTypes: ["public.plain-text"],
              },
            ],
          }
        : {}),
    },
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
    target: publicRelease
      ? [
          { target: "dmg", arch: ["arm64"] },
          { target: "zip", arch: ["arm64"] },
        ]
      : [
          { target: "dmg", arch: ["arm64"] },
          { target: "dir", arch: ["arm64"] },
        ],
    category: "public.app-category.developer-tools",
    icon: "build/icon.icns",
    type: publicRelease && !testPublicRelease ? "distribution" : undefined,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    // Electron's macOS Notification API requires a code-signed application.
    // Ad-hoc signing keeps local packages notification-capable without requiring
    // a Developer ID certificate; distribution builds use the real identity.
    identity: SIGN ? undefined : "-",
    // The app seals these PNG resources in its top-level signature. Signing
    // each preview as a separate binary would add unnecessary signing work.
    signIgnore: ["/Resources/app-icon-(?:channel-)?variants/.*\\.png$"],
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize: NOTARIZE,
  },
  dmg: {
    background: "assets/dmg/background.tiff",
    icon: null,
    iconSize: 96,
    iconTextSize: 13,
    // Center the icons and labels together within the space below Finder’s title bar.
    contents: [
      { x: 140, y: 128, type: "file" },
      { x: 420, y: 128, type: "link", path: "/Applications" },
    ],
  },
  linux: {
    extraResources: [{ from: "resources/latex/linux-${arch}", to: "latex/linux-${arch}" }],
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
    extraResources: [{ from: "resources/latex/win32-${arch}", to: "latex/win32-${arch}" }],
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
  // Public release metadata is generated locally. The packaging command never uploads.
  publish: publicRelease
    ? testPublicRelease
      ? { provider: "generic", url: updateUrl, channel: publicRelease.updaterChannel }
      : {
          provider: "github",
          owner: "enajx",
          repo: "PI-Lab",
          channel: publicRelease.updaterChannel,
          releaseType: publicRelease.channel === "beta" ? "prerelease" : "release",
        }
    : null,
}

module.exports = config
