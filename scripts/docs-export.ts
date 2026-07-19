import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, extname, join, relative, sep } from "node:path"
import { JSDOM } from "jsdom"

const repositoryRoot = join(import.meta.dir, "..")
const docsRoot = join(repositoryRoot, "docs")
const markdownRoot = join(repositoryRoot, "md")
const offlineOrigin = "https://pi-lab-offline.invalid"

const offlineStyle = `
.VPSidebarItem.collapsible > .items {
  display: block !important;
}

@media (max-width: 959px) {
  .VPNav {
    position: static !important;
  }

  .VPSidebar {
    position: static !important;
    display: block !important;
    width: auto !important;
    height: auto !important;
    max-width: none !important;
    padding: 24px !important;
    visibility: visible !important;
    opacity: 1 !important;
    transform: none !important;
  }

  .VPContent.has-sidebar {
    padding-left: 0 !important;
  }

  .VPDoc {
    padding-top: 24px !important;
  }
}
`

function toPosixPath(path: string): string {
  return path.split(sep).join("/")
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)))
    } else if (entry.isFile()) {
      files.push(path)
    }
  }

  return files
}

async function copyLinkedAttachments(sourceRoot: string, outputRoot: string): Promise<void> {
  const sourceFiles = await listFiles(sourceRoot)

  for (const sourceFile of sourceFiles) {
    if (extname(sourceFile).toLowerCase() !== ".pdf") continue

    const relativePath = relative(sourceRoot, sourceFile)
    const outputFile = join(outputRoot, relativePath)
    await mkdir(dirname(outputFile), { recursive: true })
    await copyFile(sourceFile, outputFile)
  }
}

function normalizedPathname(pathname: string): string {
  const decoded = decodeURIComponent(pathname)
  return decoded === "/" ? "/" : decoded.replace(/\/+/g, "/")
}

function htmlRoute(outputRoot: string, htmlFile: string): string {
  const relativePath = toPosixPath(relative(outputRoot, htmlFile))

  if (relativePath === "index.html") return "/"
  if (relativePath.endsWith("/index.html")) {
    return `/${relativePath.slice(0, -"index.html".length)}`
  }
  return `/${relativePath.slice(0, -".html".length)}`
}

function addOutputRoutes(
  outputRoot: string,
  outputFile: string,
  outputByRoute: Map<string, string>,
): void {
  const relativePath = toPosixPath(relative(outputRoot, outputFile))
  const fileRoute = `/${relativePath}`
  outputByRoute.set(normalizedPathname(fileRoute), outputFile)

  if (extname(outputFile).toLowerCase() !== ".html") return

  const route = htmlRoute(outputRoot, outputFile)
  outputByRoute.set(normalizedPathname(route), outputFile)

  if (route.endsWith("/")) {
    outputByRoute.set(normalizedPathname(route.slice(0, -1)), outputFile)
  } else {
    outputByRoute.set(normalizedPathname(`${route}.html`), outputFile)
  }

  if (route === "/") {
    outputByRoute.set("/00-pi-lab", outputFile)
    outputByRoute.set("/00-pi-lab.html", outputFile)
  }
}

function isExternalReference(reference: string): boolean {
  return (
    reference.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(reference) || reference.startsWith("#")
  )
}

function relativeFileReference(sourceFile: string, targetFile: string): string {
  const relativePath = toPosixPath(relative(dirname(sourceFile), targetFile))
  const prefixed = relativePath.startsWith(".") ? relativePath : `./${relativePath}`
  return encodeURI(prefixed)
}

function rewriteReference(
  reference: string,
  sourceFile: string,
  sourceRoute: string,
  outputByRoute: ReadonlyMap<string, string>,
): string {
  if (reference === "" || isExternalReference(reference)) return reference

  const resolved = new URL(reference, `${offlineOrigin}${sourceRoute}`)
  if (resolved.origin !== offlineOrigin) return reference

  const targetFile = outputByRoute.get(normalizedPathname(resolved.pathname))
  if (!targetFile) {
    throw new Error(`Unresolved local documentation reference in ${sourceFile}: ${reference}`)
  }

  return `${relativeFileReference(sourceFile, targetFile)}${resolved.search}${resolved.hash}`
}

function stripInteractiveMarkup(document: Document): void {
  document
    .querySelectorAll("script, link[rel~='modulepreload'], link[rel~='preload'][as='font']")
    .forEach((element) => {
      element.remove()
    })

  document
    .querySelectorAll(
      [
        ".VPNavBarSearch",
        ".VPNavBarAppearance",
        ".VPNavBarExtra",
        ".VPNavBarHamburger",
        ".VPLocalNav",
        ".caret",
        "button",
      ].join(","),
    )
    .forEach((element) => {
      element.remove()
    })

  document.querySelectorAll(".collapsed").forEach((element) => {
    element.classList.remove("collapsed")
  })

  document.querySelectorAll("[role='button']").forEach((element) => {
    element.removeAttribute("role")
    element.removeAttribute("tabindex")
    element.removeAttribute("aria-expanded")
  })

  document.querySelector(".VPDoc > .container > .aside")?.remove()
  document.querySelector(".VPDoc")?.classList.remove("has-aside")

  document.querySelectorAll("time[datetime]").forEach((element) => {
    if (element.textContent?.trim()) return
    element.textContent = element.getAttribute("datetime")?.slice(0, 10) ?? ""
  })
}

function markOfflineExport(document: Document): void {
  const marker = document.createElement("meta")
  marker.name = "pi-lab-offline-export"
  marker.content = "true"
  document.head.append(marker)

  const style = document.createElement("style")
  style.id = "pi-lab-offline-style"
  style.textContent = offlineStyle
  document.head.append(style)
}

async function rewriteHtml(
  outputRoot: string,
  htmlFile: string,
  outputByRoute: ReadonlyMap<string, string>,
): Promise<void> {
  const html = await readFile(htmlFile, "utf8")
  const dom = new JSDOM(html)
  const { document } = dom.window
  const sourceRoute = htmlRoute(outputRoot, htmlFile)

  stripInteractiveMarkup(document)
  markOfflineExport(document)

  document.querySelectorAll("[href], [src]").forEach((element) => {
    for (const attribute of ["href", "src"]) {
      const reference = element.getAttribute(attribute)
      if (reference === null) continue
      element.setAttribute(
        attribute,
        rewriteReference(reference, htmlFile, sourceRoute, outputByRoute),
      )
    }
  })

  await writeFile(htmlFile, dom.serialize())
}

async function rewriteCss(
  cssFile: string,
  outputByRoute: ReadonlyMap<string, string>,
): Promise<void> {
  const css = await readFile(cssFile, "utf8")
  const references = [...css.matchAll(/url\((['"]?)(\/[^'")]+)\1\)/g)]
  let rewritten = css

  for (const match of references) {
    const [source, quote, reference] = match
    const targetFile = outputByRoute.get(normalizedPathname(reference))
    if (!targetFile) {
      throw new Error(`Unresolved local documentation CSS reference in ${cssFile}: ${reference}`)
    }

    const replacement =
      extname(targetFile).toLowerCase() === ".woff2"
        ? `url(${quote}data:font/woff2;base64,${(await readFile(targetFile)).toString("base64")}${quote})`
        : `url(${quote}${relativeFileReference(cssFile, targetFile)}${quote})`
    rewritten = rewritten.replace(source, replacement)
  }

  await writeFile(cssFile, rewritten)
}

async function removeClientRuntime(outputFiles: string[]): Promise<void> {
  for (const outputFile of outputFiles) {
    const extension = extname(outputFile).toLowerCase()
    if (extension === ".js" || extension === ".woff2" || basename(outputFile) === "hashmap.json") {
      await rm(outputFile)
    }
  }
}

export async function exportOfflineDocumentation(
  outputRoot: string,
  sourceRoot: string,
): Promise<void> {
  await copyLinkedAttachments(sourceRoot, outputRoot)

  const outputFiles = await listFiles(outputRoot)
  const outputByRoute = new Map<string, string>()
  for (const outputFile of outputFiles) {
    addOutputRoutes(outputRoot, outputFile, outputByRoute)
  }

  const htmlFiles = outputFiles.filter((file) => extname(file).toLowerCase() === ".html")
  const cssFiles = outputFiles.filter((file) => extname(file).toLowerCase() === ".css")

  for (const htmlFile of htmlFiles) {
    await rewriteHtml(outputRoot, htmlFile, outputByRoute)
  }
  for (const cssFile of cssFiles) {
    await rewriteCss(cssFile, outputByRoute)
  }

  await removeClientRuntime(outputFiles)
  console.log(`Offline documentation export: ${htmlFiles.length} HTML pages in ${outputRoot}`)
}

if (import.meta.main) {
  await exportOfflineDocumentation(docsRoot, markdownRoot)
}
