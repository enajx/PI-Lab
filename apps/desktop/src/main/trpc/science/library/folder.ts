import { readdir } from "node:fs/promises"
import { basename, join, relative, resolve, sep } from "node:path"
import type { LibraryCollection, LibraryPaper } from "./parse"

/**
 * Filesystem readers for the Library tab's **local-folder** source — for researchers
 * who keep papers in a directory tree rather than Zotero (AGENTS.md "Scope" "Science
 * tabs"). Subfolders are browsed as collections, `.pdf` files as items. Kept free of
 * tRPC/Electron so they're unit-testable against a real temp dir, mirroring `parse.ts`.
 *
 * Two safety choices, both deliberate:
 *  - **Traversal guard** ({@link resolveWithin}): a collection/item key from the renderer
 *    is a relative subpath; we resolve it under the stored root and reject anything that
 *    escapes (so a crafted `../` key can't read outside the chosen folder).
 *  - **Symlinks are skipped** — `Dirent.isDirectory()`/`isFile()` are false for symlinks,
 *    so linked dirs/files are ignored. This sidesteps symlink loops and root escapes at
 *    the cost of not following links, which is the safe default for v1.
 *
 * Filename-only metadata: title is the filename minus its `.pdf` extension; no authors,
 * year, or URL are inferred (a locked product decision — see the plan).
 */

const PDF_RE = /\.pdf$/i

/**
 * Hard ceiling on how many items a single folder listing returns — a crash backstop for
 * pathological libraries (tens of thousands of PDFs), since the browser renders rows
 * without virtualization. Normal libraries never reach it; when they do the UI shows a
 * non-silent "showing first N" note nudging the user to open a subfolder. The recursive
 * walk early-exits once it hits the cap, so the work is bounded regardless of tree size.
 */
export const FOLDER_ITEM_CAP = 1000

/** Title for a folder item: the filename with a trailing `.pdf` stripped (case-insensitive). */
export function pdfTitleFromName(filename: string): string {
  return filename.replace(PDF_RE, "")
}

/**
 * Resolve `rel` (a renderer-supplied relative subpath, e.g. a collection key) under
 * `root`, returning the absolute path — or `null` when it would escape `root` (the
 * traversal guard). `root` must already be absolute. A nullish `rel` resolves to `root`.
 */
export function resolveWithin(root: string, rel?: string): string | null {
  const abs = resolve(root, rel ?? ".")
  return abs === root || abs.startsWith(root + sep) ? abs : null
}

/** Count the direct `.pdf` files and immediate (non-dot) subdirectories of `dir`. */
async function countDir(dir: string): Promise<{ pdfCount: number; subdirCount: number }> {
  let pdfCount = 0
  let subdirCount = 0
  for (const entry of await readDir(dir)) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) subdirCount++
    else if (entry.isFile() && PDF_RE.test(entry.name)) pdfCount++
  }
  return { pdfCount, subdirCount }
}

/** `readdir` with file types, treating an unreadable directory as empty (never throws). */
async function readDir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * List the immediate subdirectories of the target as {@link LibraryCollection}s. The
 * target is `root` (top level) or the `parentKey` subfolder when drilling in. Each
 * collection's `key` is its path relative to `root` (e.g. `"methods/2023"`, reused as
 * the next-level key and breadcrumb), `itemCount` its direct PDF count, and
 * `subcollectionCount` its immediate-subdir count. Returns `null` on a traversal escape.
 */
export async function listFolderCollections(
  root: string,
  parentKey?: string,
): Promise<LibraryCollection[] | null> {
  const dir = resolveWithin(root, parentKey)
  if (dir == null) return null
  const subdirs = (await readDir(dir)).filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith("."),
  )
  const collections: LibraryCollection[] = []
  for (const entry of subdirs) {
    const childAbs = join(dir, entry.name)
    const { pdfCount, subdirCount } = await countDir(childAbs)
    collections.push({
      key: relative(root, childAbs),
      name: entry.name,
      itemCount: pdfCount,
      subcollectionCount: subdirCount,
    })
  }
  return collections.sort(byNameInsensitive)
}

/** Absolute paths of `.pdf` files directly in `dir`, stopping once `limit` are collected. */
async function directPdfs(dir: string, limit: number): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readDir(dir)) {
    if (out.length >= limit) break
    if (entry.isFile() && PDF_RE.test(entry.name)) out.push(join(dir, entry.name))
  }
  return out
}

/**
 * Collect absolute paths of `.pdf` files under `dir` into `out`, recursing through
 * (non-dot) subdirectories, and **early-exit once `out` reaches `limit`** — so the work
 * stays bounded no matter how large the tree is (the crash backstop).
 */
async function walkPdfs(dir: string, limit: number, out: string[] = []): Promise<string[]> {
  if (out.length >= limit) return out
  for (const entry of await readDir(dir)) {
    if (out.length >= limit) break
    if (entry.name.startsWith(".")) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) await walkPdfs(abs, limit, out)
    else if (entry.isFile() && PDF_RE.test(entry.name)) out.push(abs)
  }
  return out
}

/** A folder item listing: the papers plus whether {@link FOLDER_ITEM_CAP} clipped them. */
export interface FolderItems {
  items: LibraryPaper[]
  /** True when the listing hit the cap and more PDFs exist than were returned. */
  truncated: boolean
}

/**
 * List `.pdf` files as {@link LibraryPaper}s. With no `collectionKey` this is the whole
 * tree ("All items", recursive); with one it's that subfolder's **direct** PDFs. `options.
 * recursive` overrides that default. Each paper's `id` is its path relative to `root`
 * (stable, and the key `openItem` resolves back to an absolute path); `title` is the
 * filename minus `.pdf`; no authors/year/url. The result is capped at
 * {@link FOLDER_ITEM_CAP} with `truncated` flagged. Returns `null` on a traversal escape.
 */
export async function listFolderItems(
  root: string,
  collectionKey?: string,
  options: { recursive?: boolean } = {},
): Promise<FolderItems | null> {
  const dir = resolveWithin(root, collectionKey)
  if (dir == null) return null
  const recursive = options.recursive ?? !collectionKey
  // Read one past the cap so we can tell "exactly the cap" from "more than the cap".
  const paths = recursive
    ? await walkPdfs(dir, FOLDER_ITEM_CAP + 1)
    : await directPdfs(dir, FOLDER_ITEM_CAP + 1)
  const truncated = paths.length > FOLDER_ITEM_CAP
  const items = paths
    .slice(0, FOLDER_ITEM_CAP)
    .map(
      (abs): LibraryPaper => ({
        id: relative(root, abs),
        title: pdfTitleFromName(basename(abs)),
        authors: [],
        itemType: "PDF",
      }),
    )
    .sort((a, b) => collator.compare(a.title, b.title))
  return { items, truncated }
}

const collator = new Intl.Collator(undefined, { sensitivity: "base" })
const byNameInsensitive = (a: { name: string }, b: { name: string }) =>
  collator.compare(a.name, b.name)
