import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { describe, expect, test } from "vitest"

const desktopDir = resolve("apps/desktop")
const desktopRequire = createRequire(join(desktopDir, "package.json"))
const builderRequire = createRequire(desktopRequire.resolve("electron-builder"))
const { FileMatcher, getMainFileMatchers } = builderRequire("app-builder-lib/out/fileMatcher.js")
const { doMergeConfigs } = builderRequire("app-builder-lib/out/util/config/config.js")
const { createElectronFrameworkSupport } = builderRequire(
  "app-builder-lib/out/electron/ElectronFramework.js",
)
const { Platform } = builderRequire("app-builder-lib")
const config = desktopRequire("./electron-builder.config.cjs")
const afterPack = desktopRequire("./scripts/electron-builder-after-pack.cjs").default
const { validatePackageDependencies } = desktopRequire(
  "./scripts/validate-package-dependencies.cjs",
)

/** Use electron-builder's real production-dependency filter for a target. */
function ships(platform: "mac" | "linux" | "win", arch: "arm64" | "x64", file: string): boolean {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Expand electron-builder's literal target macro.
  const expand = (pattern: string): string => pattern.replaceAll("${arch}", arch)
  const patterns: string[] = [...(config.files ?? []), ...(config[platform].files ?? [])]
  const matcher = new FileMatcher(desktopDir, "/tmp/pi-lab-package-test", expand)
  matcher.addPattern("**/*")
  for (const pattern of patterns.filter((item) => item.startsWith("!"))) matcher.addPattern(pattern)
  return matcher.createFilter()(
    join(desktopDir, "node_modules", file),
    statSync(import.meta.filename),
  )
}

describe("production package contents through electron-builder", () => {
  test("keeps main/daemon dependencies and the lazy WebP decoder", () => {
    for (const file of [
      "@trpc/server/dist/index.cjs",
      "@xterm/headless/lib-headless/xterm-headless.js",
      "superjson/dist/index.js",
      "copy-anything/dist/index.js",
      "zod/index.cjs",
      "drizzle-orm/better-sqlite3/index.cjs",
      "trpc-electron/dist/main.cjs",
      "omggif/omggif.js",
      "@jsquash/webp/decode.js",
      "@jsquash/webp/codec/dec/webp_dec.js",
      "@jsquash/webp/codec/dec/webp_dec.wasm",
    ])
      expect(ships("mac", "arm64", file), file).toBe(true)
  })

  test("does not ship bundled renderer packages or native build sources", () => {
    for (const file of [
      "@codemirror/view/dist/index.js",
      "@xterm/xterm/lib/xterm.js",
      "@tanstack/react-query/build/modern/index.js",
      "react/index.js",
      "recharts/lib/index.js",
      "@pi-lab/shared/package.json",
      "@radix-ui/react-slot/dist/index.js",
      "@date-fns/tz/index.js",
      "micromark/index.js",
      "d3-array/src/index.js",
      "lodash/lodash.js",
      "rrule/dist/es5/rrule.js",
      "@babel/runtime/helpers/extends.js",
      "better-sqlite3/deps/sqlite3/sqlite3.c",
      "better-sqlite3/src/addon.cpp",
      "better-sqlite3/binding.gyp",
      "node-pty/src/unix/pty.cc",
      "node-pty/deps/winpty/src/libwinpty/winpty.cc",
      "node-pty/binding.gyp",
      "node-pty/prebuilds/win32-x64/conpty.pdb",
    ])
      expect(ships("mac", "arm64", file), file).toBe(false)
  })

  test.each([
    ["mac", "arm64", "darwin"],
    ["linux", "x64", "linux"],
    ["linux", "arm64", "linux"],
    ["win", "x64", "win32"],
  ] as const)("keeps matching native files for %s/%s", (platform, arch, nativePlatform) => {
    expect(ships(platform, arch, `better-sqlite3/prebuilds/${nativePlatform}-${arch}.node`)).toBe(
      true,
    )
    expect(ships(platform, arch, "better-sqlite3/prebuilds/darwin-x64.node")).toBe(false)
    expect(ships(platform, arch, "better-sqlite3/prebuilds/win32-arm64.node")).toBe(false)
    if (platform === "linux") {
      expect(ships(platform, arch, `better-sqlite3/prebuilds/linuxmusl-${arch}.node`)).toBe(true)
      expect(ships(platform, arch, "node-pty/build/Release/pty.node")).toBe(true)
    } else {
      for (const file of platform === "mac"
        ? ["pty.node", "spawn-helper"]
        : [
            "pty.node",
            "conpty.node",
            "conpty_console_list.node",
            "winpty.dll",
            "winpty-agent.exe",
            "conpty/conpty.dll",
            "conpty/OpenConsole.exe",
          ]) {
        expect(
          ships(platform, arch, `node-pty/prebuilds/${nativePlatform}-${arch}/${file}`),
          file,
        ).toBe(true)
      }
    }
    expect(ships(platform, arch, "node-pty/prebuilds/win32-arm64/conpty.node")).toBe(false)
  })
})

test.each([
  "mac",
  "linux",
  "win",
] as const)("normalized %s app filters include only runtime outputs", (platform) => {
  const normalized = doMergeConfigs([structuredClone(config)])
  const packager = {
    info: {
      projectDir: desktopDir,
      buildResourcesDir: "build",
      isPrepackedAppAsar: false,
      config: normalized,
      debugLogger: { isEnabled: false },
    },
  }
  const matchers = getMainFileMatchers(
    desktopDir,
    "/tmp/pi-lab-app-matcher",
    (pattern: string) => pattern,
    normalized[platform],
    packager,
    join(desktopDir, "release"),
    false,
  )
  const included = (file: string): boolean =>
    matchers.some(
      (matcher: {
        createFilter: () => (path: string, stat: ReturnType<typeof statSync>) => boolean
      }) => matcher.createFilter()(join(desktopDir, file), statSync(import.meta.filename)),
    )
  for (const file of [
    "out/main/index.js",
    "out/preload/index.js",
    "out/pty-daemon/index.js",
    "out/renderer/index.html",
    "out/main/drizzle/0000.sql",
    "package.json",
  ])
    expect(included(file), file).toBe(true)
  for (const file of [
    "out/main/index.js.map",
    "out/renderer/assets/index.js.map",
    "src/main/index.ts",
    "scripts/setup-native.cjs",
    "electron-builder.config.cjs",
    "tsconfig.web.json",
  ])
    expect(included(file), file).toBe(false)
})

test.each([
  ["x64", "x64", true],
  ["arm64", "arm64", true],
  ["x64", "arm64", false],
  ["arm64", "x64", false],
] as const)("Linux afterPack checks host %s against target %s", (hostArch, targetArch, matches) => {
  const snippet = `Object.defineProperty(process, 'platform', { value: 'linux' }); Object.defineProperty(process, 'arch', { value: '${hostArch}' }); const { Arch } = require(${JSON.stringify(desktopRequire.resolve("electron-builder"))}); require(${JSON.stringify(join(desktopDir, "scripts/electron-builder-after-pack.cjs"))}).default({ electronPlatformName: 'linux', arch: Arch.${targetArch}, appOutDir: '/tmp/pi-lab-linux-host-test' });`
  const result = spawnSync(process.execPath, ["-e", snippet], { encoding: "utf8" })
  expect(result.status === 0).toBe(matches)
  if (!matches)
    expect(result.stderr).toContain(
      "Linux node-pty requires a Linux build host with the target architecture",
    )
})

test("runtime audit rejects a new external excluded from the package", () => {
  const fixture = mkdtempSync(join(tmpdir(), "pi-lab-runtime-import-"))
  for (const name of ["main", "preload", "pty-daemon"]) {
    mkdirSync(join(fixture, name))
    writeFileSync(join(fixture, name, "index.js"), name === "main" ? 'require("react")' : "")
  }
  expect(() => validatePackageDependencies(fixture, config)).toThrow(
    "runtime dependency excluded from package: react",
  )
  rmSync(fixture, { recursive: true, force: true })
})

test("runtime audit rejects an excluded transitive dependency", () => {
  const fixture = mkdtempSync(join(tmpdir(), "pi-lab-runtime-import-"))
  for (const name of ["main", "preload", "pty-daemon"]) {
    mkdirSync(join(fixture, name))
    writeFileSync(join(fixture, name, "index.js"), name === "main" ? 'require("superjson")' : "")
  }
  const missingTransitive = {
    ...config,
    files: [...(config.files ?? []), "!**/node_modules/is-what/**"],
  }
  expect(() => validatePackageDependencies(fixture, missingTransitive)).toThrow(
    "runtime dependency excluded from package: is-what",
  )
  rmSync(fixture, { recursive: true, force: true })
})

test.each([
  "linux",
  "win",
] as const)("electron-builder keeps selected %s locale filenames", async (platform) => {
  const fixture = mkdtempSync(join(tmpdir(), "pi-lab-native-locales-"))
  const localeDir = join(fixture, "locales")
  mkdirSync(localeDir)
  const selected = ["en-US", "en-GB", "zh-CN", "zh-TW", "ko", "ja", "es", "es-419"]
  for (const locale of [...selected, "fr", "de", "zh_CN"])
    writeFileSync(join(localeDir, `${locale}.pak`), locale)
  writeFileSync(join(fixture, platform === "win" ? "electron.exe" : "electron"), "fixture")
  const framework = await createElectronFrameworkSupport({ electronVersion: "40.10.4" }, {})
  await framework.beforeCopyExtraFiles({
    appOutDir: fixture,
    platformName: platform === "win" ? "win32" : "linux",
    packager: {
      platform: platform === "win" ? Platform.WINDOWS : Platform.LINUX,
      config,
      platformSpecificBuildOptions: config[platform],
      executableName: "PI Lab",
      appInfo: { productFilename: "PI Lab" },
      getResourcesDir: () => join(fixture, "resources"),
    },
  })
  const kept = readdirSync(localeDir).sort()
  rmSync(fixture, { recursive: true, force: true })
  expect(kept).toEqual(selected.map((locale) => `${locale}.pak`).sort())
})

test("selected macOS locales retain all grammatical companion resources", () => {
  const selected = ["en", "en_GB", "zh_CN", "zh_TW", "ko", "ja", "es", "es_419"]
  const companions = selected.flatMap((locale) => [
    locale,
    ...["FEMININE", "MASCULINE", "NEUTER"].map((suffix) => `${locale}_${suffix}`),
  ])
  expect(config.mac.electronLanguages).toEqual(companions)
})

test("packaged native validator loads SQLite 13's real prebuild layout", () => {
  const fixture = mkdtempSync(join(tmpdir(), "pi-lab-native-layout-"))
  const modules = join(fixture, "app.asar.unpacked", "node_modules")
  const sqliteRoot = dirname(desktopRequire.resolve("better-sqlite3/package.json"))
  const ptyRoot = resolve(desktopRequire.resolve("node-pty"), "../..")
  const sqliteDest = join(modules, "better-sqlite3", "prebuilds")
  const ptyDest = join(modules, "node-pty", "build", "Release")
  mkdirSync(sqliteDest, { recursive: true })
  mkdirSync(ptyDest, { recursive: true })
  copyFileSync(
    join(sqliteRoot, "prebuilds", `${process.platform}-${process.arch}.node`),
    join(sqliteDest, `${process.platform}-${process.arch}.node`),
  )
  const names =
    process.platform === "darwin"
      ? ["pty.node", "spawn-helper"]
      : process.platform === "win32"
        ? [
            "pty.node",
            "conpty.node",
            "conpty_console_list.node",
            "winpty.dll",
            "winpty-agent.exe",
            "conpty/conpty.dll",
            "conpty/OpenConsole.exe",
          ]
        : ["pty.node"]
  const ptySource =
    process.platform === "win32"
      ? join(ptyRoot, "prebuilds", `${process.platform}-${process.arch}`)
      : join(ptyRoot, "build", "Release")
  for (const name of names) {
    mkdirSync(dirname(join(ptyDest, name)), { recursive: true })
    copyFileSync(join(ptySource, name), join(ptyDest, name))
  }
  const result = spawnSync(
    process.execPath,
    [join(desktopDir, "scripts/validate-native.cjs"), "--app", fixture],
    { encoding: "utf8" },
  )
  rmSync(fixture, { recursive: true, force: true })
  expect(result.stderr).toBe("")
  expect(result.status).toBe(0)
})

test("afterPack fails when the macOS PTY helper is missing", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "pi-lab-native-helper-"))
  await expect(afterPack({ appOutDir: fixture, electronPlatformName: "darwin" })).rejects.toThrow(
    "spawn-helper",
  )
  rmSync(fixture, { recursive: true, force: true })
})

test("afterPack restores the macOS PTY helper execute bits", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "pi-lab-native-helper-"))
  const helper = join(fixture, "spawn-helper")
  writeFileSync(helper, "helper", { mode: 0o644 })
  await afterPack({ appOutDir: fixture, electronPlatformName: "darwin" })
  const mode = statSync(helper).mode
  rmSync(fixture, { recursive: true, force: true })
  expect(mode & 0o111).toBe(0o111)
})
