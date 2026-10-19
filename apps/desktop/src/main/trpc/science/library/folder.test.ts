// Unit tests for the folder-source filesystem readers. These
// are pure of tRPC/Electron, so they run against real temp directories — no mocking.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import {
  FOLDER_ITEM_CAP,
  listFolderCollections,
  listFolderItems,
  pdfTitleFromName,
  resolveWithin,
} from "./folder"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/**
 * A small library tree:
 *   root/Top.pdf, root/notes.txt (ignored), root/.hidden/secret.pdf (ignored)
 *   root/methods/{alpha,beta}.pdf + root/methods/2023/deep.pdf
 */
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-lab-folder-"))
  dirs.push(root)
  await writeFile(join(root, "Top.pdf"), "x")
  await writeFile(join(root, "notes.txt"), "x")
  await mkdir(join(root, "methods", "2023"), { recursive: true })
  await writeFile(join(root, "methods", "alpha.pdf"), "x")
  await writeFile(join(root, "methods", "beta.pdf"), "x")
  await writeFile(join(root, "methods", "2023", "deep.pdf"), "x")
  await mkdir(join(root, ".hidden"))
  await writeFile(join(root, ".hidden", "secret.pdf"), "x")
  return root
}

describe("pdfTitleFromName", () => {
  test("strips a trailing .pdf (case-insensitive), keeps inner dots", () => {
    expect(pdfTitleFromName("Smith2020.pdf")).toBe("Smith2020")
    expect(pdfTitleFromName("scan.PDF")).toBe("scan")
    expect(pdfTitleFromName("dotted.name.pdf")).toBe("dotted.name")
    expect(pdfTitleFromName("no-extension")).toBe("no-extension")
  })
})

describe("resolveWithin", () => {
  test("resolves a subpath under the root", async () => {
    const root = await fixture()
    expect(resolveWithin(root, "methods")).toBe(join(root, "methods"))
    expect(resolveWithin(root)).toBe(root)
  })

  test("rejects paths that escape the root (traversal guard)", async () => {
    const root = await fixture()
    expect(resolveWithin(root, "..")).toBeNull()
    expect(resolveWithin(root, "../escape")).toBeNull()
    expect(resolveWithin(root, "methods/../../outside")).toBeNull()
  })
})

describe("listFolderCollections", () => {
  test("maps immediate subdirectories to collections with counts (dot-dirs excluded)", async () => {
    const root = await fixture()
    const collections = await listFolderCollections(root)
    expect(collections).toEqual([
      { key: "methods", name: "methods", itemCount: 2, subcollectionCount: 1 },
    ])
  })

  test("lists the subcollections of a drilled-in collection", async () => {
    const root = await fixture()
    const collections = await listFolderCollections(root, "methods")
    expect(collections).toEqual([
      { key: join("methods", "2023"), name: "2023", itemCount: 1, subcollectionCount: 0 },
    ])
  })

  test("rejects a traversal key", async () => {
    const root = await fixture()
    expect(await listFolderCollections(root, "..")).toBeNull()
  })
})

describe("listFolderItems", () => {
  test('"All items" walks the whole tree (recursive), skipping non-PDFs and dot-dirs', async () => {
    const root = await fixture()
    const listed = await listFolderItems(root)
    expect(listed?.truncated).toBe(false)
    const titles = listed?.items.map((i) => i.title).sort()
    expect(titles).toEqual(["Top", "alpha", "beta", "deep"])
    // ids are paths relative to the root; metadata is filename-only.
    const top = listed?.items.find((i) => i.title === "Top")
    expect(top?.id).toBe("Top.pdf")
    expect(top?.authors).toEqual([])
    expect(top?.itemType).toBe("PDF")
  })

  test("a collection lists only its direct PDFs (non-recursive)", async () => {
    const root = await fixture()
    const listed = await listFolderItems(root, "methods")
    expect(listed?.items.map((i) => i.title)).toEqual(["alpha", "beta"])
  })

  test("rejects a traversal key", async () => {
    const root = await fixture()
    expect(await listFolderItems(root, "../..")).toBeNull()
  })

  test("caps a pathological listing and flags it truncated", async () => {
    const big = await mkdtemp(join(tmpdir(), "pi-lab-folder-big-"))
    dirs.push(big)
    await Promise.all(
      Array.from({ length: FOLDER_ITEM_CAP + 1 }, (_, i) => writeFile(join(big, `p${i}.pdf`), "x")),
    )
    const listed = await listFolderItems(big)
    expect(listed?.truncated).toBe(true)
    expect(listed?.items).toHaveLength(FOLDER_ITEM_CAP)
  })
})
