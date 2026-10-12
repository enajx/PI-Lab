#!/usr/bin/env node
// @ts-check
/**
 * Check emitted main/preload/daemon imports against the real package filter.
 * Required transitive dependencies also must ship. node-addon-api is a build
 * dependency of the native modules and is not needed to load their binaries.
 */

const { existsSync, readdirSync, readFileSync, statSync } = require("node:fs")
const { createRequire, isBuiltin } = require("node:module")
const { dirname, join, relative, resolve } = require("node:path")
const ts = require("typescript")

const DESKTOP_DIR = resolve(__dirname, "..")
const desktopRequire = createRequire(join(DESKTOP_DIR, "package.json"))
const builderRequire = createRequire(desktopRequire.resolve("electron-builder"))
const { FileMatcher } = builderRequire("app-builder-lib/out/fileMatcher.js")

/** @param {string} dir @returns {string[]} Read every emitted JS chunk. */
function javascriptFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name)
    return entry.isDirectory() ? javascriptFiles(file) : entry.name.endsWith(".js") ? [file] : []
  })
}

/** @param {string} file @returns {Set<string>} Find literal emitted module imports. */
function importsIn(file) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  /** @type {Set<string>} */
  const imports = new Set()
  /** @param {import("typescript").Node} node */
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.add(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression
      const isImport = expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(expression) && expression.text === "require"
      const isResolve =
        ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "require" &&
        expression.name.text === "resolve"
      if (
        (isImport || isRequire || isResolve) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        imports.add(node.arguments[0].text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return imports
}

/** @param {string} specifier @returns {string} Strip a package subpath. */
function packageName(specifier) {
  return specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/")
}

/** @param {string} entry @param {string} name @returns {string} Locate the package manifest. */
function packageDir(entry, name) {
  let dir = dirname(entry)
  for (;;) {
    const manifest = join(dir, "package.json")
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`package.json missing for ${name}: ${entry}`)
    dir = parent
  }
}

/**
 * @param {string} outputRoot
 * @param {import("electron-builder").Configuration} config
 * Fail if the compiled runtime or its required dependency would be excluded.
 */
function validatePackageDependencies(outputRoot, config) {
  const platform =
    process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux"
  const patterns = [...(config.files ?? []), ...(config[platform].files ?? [])]
  const matcher = new FileMatcher(DESKTOP_DIR, "/tmp/pi-lab-runtime-audit", (pattern) =>
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Match electron-builder's target macro.
    pattern.replaceAll("${arch}", process.arch),
  )
  matcher.addPattern("**/*")
  for (const pattern of patterns)
    if (typeof pattern === "string" && pattern.startsWith("!")) matcher.addPattern(pattern)
  const filter = matcher.createFilter()
  const stat = statSync(__filename)
  /** @type {Set<string>} */
  const seen = new Set()
  /** @param {string} specifier @param {NodeRequire} fromRequire */
  function check(specifier, fromRequire) {
    if (
      specifier.startsWith(".") ||
      specifier.startsWith("/") ||
      isBuiltin(specifier) ||
      specifier === "electron"
    )
      return
    const name = packageName(specifier)
    const entry = fromRequire.resolve(specifier)
    const dir = packageDir(entry, name)
    const shippedPath = join(DESKTOP_DIR, "node_modules", name, relative(dir, entry))
    if (!filter(shippedPath, stat))
      throw new Error(`runtime dependency excluded from package: ${specifier}`)
    if (seen.has(dir)) return
    seen.add(dir)
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
    const packageRequire = createRequire(join(dir, "package.json"))
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (dependency !== "node-addon-api") check(dependency, packageRequire)
    }
  }
  for (const dir of ["main", "preload", "pty-daemon"]) {
    for (const file of javascriptFiles(join(outputRoot, dir))) {
      for (const specifier of importsIn(file)) check(specifier, desktopRequire)
    }
  }
  console.log(`validate:package — ${seen.size} runtime dependencies included`)
}

module.exports = { validatePackageDependencies }
if (require.main === module)
  validatePackageDependencies(join(DESKTOP_DIR, "out"), require("../electron-builder.config.cjs"))
