import { readdir, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

const RENDERER_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../apps/desktop/out/renderer",
)

interface SourceMap {
  version: number
  sources: string[]
  sourcesContent: string[]
  mappings: string
}

/** Inspect the same production output used by Electron, following only static imports. */
test("Dashboard startup excludes deferred modules and keeps usable hidden debug maps", async () => {
  const assetsDir = join(RENDERER_DIR, "assets")
  const filenames = (await readdir(assetsDir)).filter((name) => name.endsWith(".js"))
  const scripts = new Map(
    await Promise.all(
      filenames.map(async (name) => [name, await readFile(join(assetsDir, name), "utf8")] as const),
    ),
  )
  const html = await readFile(join(RENDERER_DIR, "index.html"), "utf8")
  const entry = html.match(/src="\.\/assets\/([^"?]+\.js)"/)?.[1]
  expect(entry, "renderer entry must exist").toBeTruthy()
  const dashboard = [...scripts].find(([, source]) =>
    /["']data-testid["']\s*:\s*["']dashboard["']/.test(source),
  )?.[0]
  const shell = filenames.find((name) => /^_shell-/.test(name))
  expect(dashboard, "Dashboard route must exist").toBeTruthy()
  expect(shell, "shell route must exist").toBeTruthy()
  if (!entry || !dashboard || !shell) throw new Error("Missing startup entry")

  const startup = new Set<string>()
  const visit = (name: string): void => {
    if (startup.has(name)) return
    const source = scripts.get(name)
    if (source === undefined) throw new Error(`Missing imported chunk: ${name}`)
    startup.add(name)
    for (const match of source.matchAll(/\b(?:from\s*|import\s*)["']\.\/([^"']+\.js)["']/g)) {
      visit(match[1])
    }
  }
  for (const root of [entry, dashboard, shell]) visit(root)
  const startupSource = [...startup].map((name) => scripts.get(name)).join("\n")
  // Stable runtime strings make the pre-minification build fail for actual eager code.
  expect(
    startupSource.includes("Unrecognized extension value in extension set"),
    "CodeMirror must be deferred",
  ).toBe(false)
  expect(startupSource.includes("xterm-scroll-area"), "xterm must be deferred").toBe(false)
  expect(
    startupSource.includes("RRule error: Unable to fully convert"),
    "recurrence must be deferred",
  ).toBe(false)
  expect(
    /["']data-testid["']\s*:\s*["']markdown["']/.test(startupSource),
    "Markdown must be deferred",
  ).toBe(false)
  expect(
    /["']data-testid["']\s*:\s*["']settings-app-icon-/.test(startupSource),
    "Settings views must be deferred",
  ).toBe(false)

  const localeChunks = new Set<string>()
  for (const locale of ["es", "ar", "ja", "ko", "nb", "zh-CN"]) {
    const chunk = filenames.find((name) => name.startsWith(`${locale}-`))
    expect(chunk, `${locale} must remain available`).toBeTruthy()
    if (!chunk) throw new Error(`Missing locale ${locale}`)
    localeChunks.add(chunk)
    expect(startup.has(chunk), `${locale} must be deferred`).toBe(false)
  }

  const startupModules: string[] = []
  const allModules: string[] = []
  for (const [name, source] of scripts) {
    const map = JSON.parse(await readFile(join(assetsDir, `${name}.map`), "utf8")) as SourceMap
    expect(map.version).toBe(3)
    // Rollup's generated JSON-only locale modules have no source mappings.
    if (!localeChunks.has(name)) {
      expect(map.mappings.length).toBeGreaterThan(0)
      expect(map.sourcesContent.some((content) => content.length > 0)).toBe(true)
    }
    expect(source).not.toContain("sourceMappingURL=")
    // Minified chunks can retain line breaks inside string literals and licenses.
    const lines = source.trimEnd().split("\n").length
    if (source.length < 500) {
      expect(lines, `${name} should be minified`).toBe(1)
    } else {
      expect(source.length / lines, `${name} should be minified`).toBeGreaterThan(100)
    }
    allModules.push(...map.sources)
    if (startup.has(name)) startupModules.push(...map.sources)
  }
  const deferred = [
    "/SettingsSections.tsx",
    "/WorkflowResultDialog.tsx",
    "/Terminal/Terminal.tsx",
    "/@codemirror/",
    "/react-markdown/",
    "/rrule/",
  ]
  for (const module of deferred) {
    expect(
      allModules.some((source) => source.includes(module)),
      `${module} must remain available`,
    ).toBe(true)
    expect(
      startupModules.some((source) => source.includes(module)),
      `${module} must be deferred`,
    ).toBe(false)
  }
  console.info(
    "Renderer startup output:",
    JSON.stringify({
      startupChunks: [...startup],
      startupBytes: Buffer.byteLength(startupSource),
      totalChunks: scripts.size,
    }),
  )
})
