import { existsSync } from "node:fs"
import { extname, join, normalize, sep } from "node:path"

const root = join(import.meta.dir, "..", "docs")
const hostname = "127.0.0.1"
const port = 4173

if (!existsSync(root)) {
  throw new Error(`Documentation build not found at ${root}; run bun run docs:build first`)
}

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
}

function resolvePage(pathname: string): string | null {
  const relative = normalize(pathname).replace(/^[/\\]+/, "")
  const absolute = join(root, relative)
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return null

  const candidates =
    pathname.endsWith("/") || absolute === root
      ? [join(absolute, "index.html")]
      : extname(absolute)
        ? [absolute]
        : [`${absolute}.html`, join(absolute, "index.html")]

  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

const server = Bun.serve({
  hostname,
  port,
  fetch(request) {
    const url = new URL(request.url)
    const page = resolvePage(url.pathname)
    const filePath = page ?? join(root, "404.html")
    const status = page ? 200 : 404
    return new Response(Bun.file(filePath), {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    })
  },
})

console.log(`Private PI Lab documentation: http://${server.hostname}:${server.port}/`)
