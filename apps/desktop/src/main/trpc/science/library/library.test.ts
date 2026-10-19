// Integration tests for the science.library router via createCallerFactory over
// a temp SQLite DB with the real migrations. Outbound HTTP is
// the injected fake (`httpFetch`) so the real Zotero API is never hit; the folder source
// reads real temp dirs and opens files through the injected `openPath`. We assert
// kind/mode-aware reads (Zotero local vs web, and folder), credential/coercion
// persistence, the attach-file write paths, browsing, and the typed not-connected/error
// outcomes.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type LibrarySource, SETTINGS_ROW_ID, settings } from "@pi-lab/local-db"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import type { HttpFetch } from "../../context"
import { createHarness, FAKE_AGENT, type Harness } from "../../testHarness"

/** A recorded outbound request — url plus the init (so tests can assert headers/body). */
interface Recorded {
  url: string
  init?: RequestInit
}

/** Build a `Response`-like fake from a body + status, supporting both `.json()` and `.text()`. */
function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const status = init.status ?? 200
  const ok = init.ok ?? (status >= 200 && status < 300)
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as Response
}

/** A fetch fake that records each (url, init) and routes by first url-substring match. */
function stubFetch(
  routes: Record<string, (url: string, init?: RequestInit) => Response>,
  recorded: Recorded[] = [],
): HttpFetch {
  return async (input, init) => {
    const url = String(input)
    const requestInit = init as RequestInit | undefined
    recorded.push({ url, init: requestInit })
    for (const [needle, make] of Object.entries(routes)) {
      if (url.includes(needle)) return make(url, requestInit)
    }
    throw new TypeError(`fetch failed: no stub for ${url}`)
  }
}

/** Read a header off a recorded request's init (our routers pass plain-object headers). */
function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name]
}

const ZOTERO_ITEMS = [
  {
    key: "ABCD1234",
    data: {
      title: "Attention Is All You Need",
      itemType: "conferencePaper",
      date: "2017-06-12",
      DOI: "10.5555/3295222.3295349",
      url: "https://example.org/attention",
      creators: [{ firstName: "Ashish", lastName: "Vaswani" }, { name: "Google Brain" }],
    },
  },
  {
    key: "EFGH5678",
    data: { title: "No Authors Here", itemType: "journalArticle", date: "2020" },
  },
]

const ZOTERO_COLLECTIONS = [
  { key: "COLL1", data: { name: "Methods" }, meta: { numItems: 3, numCollections: 1 } },
  { key: "COLL2", data: { name: "Results" }, meta: { numItems: 0, numCollections: 0 } },
]

let h: Harness
const tmpDirs: string[] = []

/** Create a real temp file (the web upload path reads + hashes it for real). */
async function tempFile(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-zot-"))
  tmpDirs.push(dir)
  const path = join(dir, name)
  await writeFile(path, body)
  return path
}

/** A small folder library: root/Top.pdf + root/methods/alpha.pdf. Returns the root. */
async function folderFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-lab-libfolder-"))
  tmpDirs.push(root)
  await writeFile(join(root, "Top.pdf"), "x")
  await mkdir(join(root, "methods"), { recursive: true })
  await writeFile(join(root, "methods", "alpha.pdf"), "x")
  return root
}

afterEach(async () => {
  await h?.dispose()
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("science.library connect / getStatus / disconnect (web)", () => {
  beforeEach(async () => {
    // connect runs a one-item probe before persisting; stub it as reachable.
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch({ "api.zotero.org": () => jsonResponse([]) }),
    })
  })

  test("getStatus reports not connected on a fresh DB", async () => {
    expect(await h.caller.science.library.getStatus()).toEqual({ connected: false })
  })

  test("connect (web) persists creds; getStatus reflects them sans the key", async () => {
    const status = await h.caller.science.library.connect({
      kind: "zotero",
      mode: "web",
      apiKey: "secret-key",
      libraryType: "user",
      libraryId: "123456",
    })
    expect(status).toEqual({
      connected: true,
      kind: "zotero",
      mode: "web",
      libraryType: "user",
      libraryId: "123456",
      canWrite: true,
    })

    const after = await h.caller.science.library.getStatus()
    expect(after).toMatchObject({
      connected: true,
      kind: "zotero",
      mode: "web",
      libraryId: "123456",
    })
    // The status surface never carries the API key.
    expect(JSON.stringify(after)).not.toContain("secret-key")
  })

  test("disconnect clears the stored connection", async () => {
    await h.caller.science.library.connect({
      kind: "zotero",
      mode: "web",
      apiKey: "k",
      libraryType: "group",
      libraryId: "999",
    })
    expect((await h.caller.science.library.getStatus()).connected).toBe(true)

    const status = await h.caller.science.library.disconnect()
    expect(status).toEqual({ connected: false })
    expect((await h.caller.science.library.getStatus()).connected).toBe(false)
  })

  test("connect rejects when the Zotero probe fails (creds not persisted)", async () => {
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch({
        "api.zotero.org": () => jsonResponse(null, { ok: false, status: 403 }),
      }),
    })
    await expect(
      h.caller.science.library.connect({
        kind: "zotero",
        mode: "web",
        apiKey: "bad",
        libraryType: "user",
        libraryId: "1",
      }),
    ).rejects.toThrow(/403/)
    expect((await h.caller.science.library.getStatus()).connected).toBe(false)
  })
})

describe("science.library local mode", () => {
  test("connect (local) probes localhost with no key and persists the personal library", async () => {
    const reqs: Recorded[] = []
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch({ "localhost:23119/api": () => jsonResponse([]) }, reqs),
    })
    const status = await h.caller.science.library.connect({ kind: "zotero", mode: "local" })
    expect(status).toEqual({
      connected: true,
      kind: "zotero",
      mode: "local",
      libraryType: "user",
      libraryId: "0",
      canWrite: false,
    })
    // Probe hit the local API at /users/0 …
    expect(reqs.some((r) => r.url.includes("localhost:23119/api/users/0/items?limit=1"))).toBe(true)
    // … and NO request carried an API key header.
    expect(reqs.every((r) => headerOf(r.init, "Zotero-API-Key") === undefined)).toBe(true)
  })

  test("listItems (local) lists from the local API with no key header", async () => {
    const reqs: Recorded[] = []
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch(
        {
          "/items?limit=1": () => jsonResponse([]),
          "/items/top": () => jsonResponse(ZOTERO_ITEMS),
        },
        reqs,
      ),
    })
    await h.caller.science.library.connect({ kind: "zotero", mode: "local" })
    const result = await h.caller.science.library.listItems({})
    if (!result.ok) throw new Error("expected ok result")
    expect(result.items).toHaveLength(2)
    expect(reqs.some((r) => r.url.includes("localhost:23119/api/users/0/items/top"))).toBe(true)
    expect(reqs.every((r) => headerOf(r.init, "Zotero-API-Key") === undefined)).toBe(true)
  })

  test("a stored bridge token enables writes (canWrite) without surfacing the token", async () => {
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch({ "localhost:23119/api": () => jsonResponse([]) }),
    })
    const status = await h.caller.science.library.connect({
      kind: "zotero",
      mode: "local",
      bridgeToken: "tok-123",
    })
    expect(status.canWrite).toBe(true)
    expect(JSON.stringify(await h.caller.science.library.getStatus())).not.toContain("tok-123")
  })

  test("connect (local) surfaces Zotero's reason when the local API is disabled", async () => {
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch({
        "localhost:23119/api": () =>
          jsonResponse("Local API is not enabled", { ok: false, status: 403 }),
      }),
    })
    // The message carries Zotero's reason AND the enablement steps.
    await expect(
      h.caller.science.library.connect({ kind: "zotero", mode: "local" }),
    ).rejects.toThrow(/Local API is not enabled.*Allow other applications/s)
    expect((await h.caller.science.library.getStatus()).connected).toBe(false)
  })

  test("legacy rows (no kind/mode) coerce to Zotero web and list from the cloud with the key", async () => {
    const reqs: Recorded[] = []
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch({ "/items/top": () => jsonResponse(ZOTERO_ITEMS) }, reqs),
    })
    // Simulate a connection persisted before kind/mode existed.
    h.db
      .insert(settings)
      .values({
        id: SETTINGS_ROW_ID,
        // A pre-union blob (no `kind`, no `mode`), exactly as older builds persisted it.
        zotero: {
          apiKey: "legacy-key",
          libraryType: "user",
          libraryId: "7",
        } as unknown as LibrarySource,
        updatedAt: Date.now(),
      })
      .run()

    expect(await h.caller.science.library.getStatus()).toMatchObject({
      connected: true,
      kind: "zotero",
      mode: "web",
      libraryId: "7",
      canWrite: true,
    })
    const result = await h.caller.science.library.listItems({})
    if (!result.ok) throw new Error("expected ok result")
    expect(reqs.some((r) => r.url.includes("api.zotero.org/users/7/items/top"))).toBe(true)
    expect(reqs.some((r) => headerOf(r.init, "Zotero-API-Key") === "legacy-key")).toBe(true)
  })
})

describe("science.library folder source", () => {
  test("connect (folder) validates the directory and stores it read-only", async () => {
    h = await createHarness()
    const root = await folderFixture()
    const status = await h.caller.science.library.connect({ kind: "folder", folderPath: root })
    expect(status).toMatchObject({
      connected: true,
      kind: "folder",
      folderPath: root,
      canWrite: false,
    })
    expect(await h.caller.science.library.getStatus()).toMatchObject({
      kind: "folder",
      folderPath: root,
    })
  })

  test("connect (folder) rejects a path that isn't a directory (not persisted)", async () => {
    h = await createHarness()
    await expect(
      h.caller.science.library.connect({ kind: "folder", folderPath: "/no/such/pi-lab-dir-xyz" }),
    ).rejects.toThrow(/not found|not a directory/i)
    expect((await h.caller.science.library.getStatus()).connected).toBe(false)
  })

  test("browses subfolders as collections and PDFs as items (recursive vs scoped)", async () => {
    h = await createHarness()
    const root = await folderFixture()
    await h.caller.science.library.connect({ kind: "folder", folderPath: root })

    const cols = await h.caller.science.library.listCollections()
    if (!cols.ok) throw new Error("expected ok result")
    expect(cols.collections.map((c) => c.name)).toEqual(["methods"])

    // "All items" walks the whole tree.
    const all = await h.caller.science.library.listItems({})
    if (!all.ok) throw new Error("expected ok result")
    expect(all.items.map((i) => i.title).sort()).toEqual(["Top", "alpha"])

    // A collection lists only its direct PDFs.
    const scoped = await h.caller.science.library.listItems({ collectionKey: "methods" })
    if (!scoped.ok) throw new Error("expected ok result")
    expect(scoped.items.map((i) => i.title)).toEqual(["alpha"])
  })

  test("openItem opens a file resolved under the folder root", async () => {
    const opened: string[] = []
    h = await createHarness([FAKE_AGENT], {
      openPath: async (p) => {
        opened.push(p)
        return ""
      },
    })
    const root = await folderFixture()
    await h.caller.science.library.connect({ kind: "folder", folderPath: root })
    const result = await h.caller.science.library.openItem({ path: join("methods", "alpha.pdf") })
    expect(result).toEqual({ ok: true })
    expect(opened).toEqual([join(root, "methods", "alpha.pdf")])
  })

  test("openItem rejects a path that escapes the folder (traversal guard)", async () => {
    h = await createHarness()
    const root = await folderFixture()
    await h.caller.science.library.connect({ kind: "folder", folderPath: root })
    const result = await h.caller.science.library.openItem({ path: "../../etc/passwd" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error result")
    expect(result.reason).toBe("error")
  })

  test("attachFile is writes-disabled for a folder source", async () => {
    h = await createHarness()
    const root = await folderFixture()
    await h.caller.science.library.connect({ kind: "folder", folderPath: root })
    const result = await h.caller.science.library.attachFile({
      itemKey: "x",
      filePath: join(root, "Top.pdf"),
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error result")
    expect(result.reason).toBe("writes-disabled")
  })

  test("openItem is not-supported for a Zotero source", async () => {
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch({ "api.zotero.org": () => jsonResponse([]) }),
    })
    await h.caller.science.library.connect({
      kind: "zotero",
      mode: "web",
      apiKey: "k",
      libraryType: "user",
      libraryId: "1",
    })
    const result = await h.caller.science.library.openItem({ path: "x.pdf" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error result")
    expect(result.reason).toBe("not-supported")
  })
})

describe("science.library.openZoteroItem", () => {
  /** Connect a web Zotero source, stubbing the connect probe + the item's `/children` list. */
  async function connectWebWithChildren(
    children: (url: string) => Response,
    openPath?: (p: string) => Promise<string>,
  ): Promise<void> {
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch({ "/items?limit=1": () => jsonResponse([]), "/children": children }),
      ...(openPath ? { openPath } : {}),
    })
    await h.caller.science.library.connect({
      kind: "zotero",
      mode: "web",
      apiKey: "k",
      libraryType: "user",
      libraryId: "42",
    })
  }

  test("opens a linked_file attachment that exists on disk, recording the absolute path", async () => {
    const opened: string[] = []
    const file = await tempFile("paper.pdf", "%PDF-1.4")
    await connectWebWithChildren(
      () =>
        jsonResponse([
          {
            key: "ATT1",
            data: {
              itemType: "attachment",
              linkMode: "linked_file",
              path: file,
              contentType: "application/pdf",
            },
          },
        ]),
      async (p) => {
        opened.push(p)
        return ""
      },
    )
    const result = await h.caller.science.library.openZoteroItem({ itemKey: "ABCD1234" })
    expect(result).toEqual({ ok: true })
    expect(opened).toEqual([file])
  })

  test("opens a standalone attachment item (no parent) by resolving the item itself", async () => {
    const opened: string[] = []
    const file = await tempFile("standalone.pdf", "%PDF-1.4")
    h = await createHarness([FAKE_AGENT], {
      // Order matters: `/children` is matched before `/items/ABCD1234` (substring of the children
      // URL). The standalone attachment has no children, so the router falls back to `/items/{key}`.
      httpFetch: stubFetch({
        "/items?limit=1": () => jsonResponse([]),
        "/children": () => jsonResponse([]),
        "/items/ABCD1234": () =>
          jsonResponse({
            key: "ABCD1234",
            data: {
              itemType: "attachment",
              linkMode: "linked_file",
              path: file,
              contentType: "application/pdf",
            },
          }),
      }),
      openPath: async (p) => {
        opened.push(p)
        return ""
      },
    })
    await h.caller.science.library.connect({
      kind: "zotero",
      mode: "web",
      apiKey: "k",
      libraryType: "user",
      libraryId: "42",
    })
    const result = await h.caller.science.library.openZoteroItem({ itemKey: "ABCD1234" })
    expect(result).toEqual({ ok: true })
    expect(opened).toEqual([file])
  })

  test("returns no-local-file when the item has no file attachment (only a note / web link)", async () => {
    await connectWebWithChildren(() =>
      jsonResponse([
        { key: "N1", data: { itemType: "note" } },
        { key: "L1", data: { itemType: "attachment", linkMode: "linked_url", url: "https://x" } },
      ]),
    )
    const result = await h.caller.science.library.openZoteroItem({ itemKey: "ABCD1234" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error result")
    expect(result.reason).toBe("no-local-file")
    expect(result.message).toContain("No local copy available")
  })

  test("returns no-local-file when a linked_file points at a missing path", async () => {
    await connectWebWithChildren(() =>
      jsonResponse([
        {
          key: "ATT1",
          data: {
            itemType: "attachment",
            linkMode: "linked_file",
            path: "/no/such/pi-lab-missing-xyz.pdf",
          },
        },
      ]),
    )
    const result = await h.caller.science.library.openZoteroItem({ itemKey: "ABCD1234" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error result")
    expect(result.reason).toBe("no-local-file")
  })

  test("surfaces a failed /children fetch as a typed error (no throw)", async () => {
    await connectWebWithChildren(() => jsonResponse(null, { ok: false, status: 500 }))
    const result = await h.caller.science.library.openZoteroItem({ itemKey: "ABCD1234" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error result")
    expect(result.reason).toBe("error")
    expect(result.message).toContain("500")
  })

  test("not-connected on a fresh DB", async () => {
    h = await createHarness()
    const result = await h.caller.science.library.openZoteroItem({ itemKey: "X" })
    expect(result).toEqual({ ok: false, reason: "not-connected" })
  })

  test("not-supported for a folder source", async () => {
    h = await createHarness()
    const root = await folderFixture()
    await h.caller.science.library.connect({ kind: "folder", folderPath: root })
    const result = await h.caller.science.library.openZoteroItem({ itemKey: "X" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error result")
    expect(result.reason).toBe("not-supported")
  })
})

describe("science.library.detectLocal", () => {
  test("reachable when the local API responds ok", async () => {
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch({ "localhost:23119/api": () => jsonResponse([]) }),
    })
    expect(await h.caller.science.library.detectLocal()).toEqual({ reachable: true })
  })

  test("not reachable (no throw) when the local server is down", async () => {
    h = await createHarness([FAKE_AGENT], {
      httpFetch: async () => {
        throw new TypeError("ECONNREFUSED")
      },
    })
    expect((await h.caller.science.library.detectLocal()).reachable).toBe(false)
  })
})

describe("science.library.listItems", () => {
  test("returns a typed not-connected result when no creds are stored", async () => {
    h = await createHarness()
    const result = await h.caller.science.library.listItems({})
    expect(result).toEqual({ ok: false, reason: "not-connected" })
  })

  test("parses a mocked Zotero response into papers (web)", async () => {
    const reqs: Recorded[] = []
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch(
        {
          // probe (connect) and the top-items list both match this host.
          "/items?limit=1": () => jsonResponse([]),
          "/items/top": () => jsonResponse(ZOTERO_ITEMS),
        },
        reqs,
      ),
    })
    await h.caller.science.library.connect({
      kind: "zotero",
      mode: "web",
      apiKey: "k",
      libraryType: "user",
      libraryId: "42",
    })

    const result = await h.caller.science.library.listItems({})
    if (!result.ok) throw new Error("expected ok result")
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({
      id: "ABCD1234",
      title: "Attention Is All You Need",
      authors: ["Ashish Vaswani", "Google Brain"],
      year: 2017,
      itemType: "conferencePaper",
      doi: "10.5555/3295222.3295349",
      url: "https://example.org/attention",
    })
    expect(result.items[1]).toMatchObject({ title: "No Authors Here", authors: [], year: 2020 })

    // The request targets the user library's top items (key in the header, not URL).
    expect(reqs.some((r) => r.url.includes("/users/42/items/top"))).toBe(true)
    expect(reqs.every((r) => !r.url.includes("k"))).toBe(true)
  })

  test("a fetch error surfaces as a typed error result (no throw)", async () => {
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch({
        "/items?limit=1": () => jsonResponse([]),
        "/items/top": () => jsonResponse(null, { ok: false, status: 500 }),
      }),
    })
    await h.caller.science.library.connect({
      kind: "zotero",
      mode: "web",
      apiKey: "k",
      libraryType: "user",
      libraryId: "1",
    })

    const result = await h.caller.science.library.listItems({})
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error result")
    expect(result.reason).toBe("error")
    expect(result.message).toContain("500")
  })
})

describe("science.library.attachFile", () => {
  test("not-connected on a fresh DB", async () => {
    h = await createHarness()
    const result = await h.caller.science.library.attachFile({
      itemKey: "X",
      filePath: "/tmp/x.md",
    })
    expect(result).toEqual({ ok: false, reason: "not-connected" })
  })

  test("local mode is writes-disabled without a bridge token", async () => {
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch({ "localhost:23119/api": () => jsonResponse([]) }),
    })
    await h.caller.science.library.connect({ kind: "zotero", mode: "local" })
    const result = await h.caller.science.library.attachFile({
      itemKey: "DOC1",
      filePath: "/tmp/x.md",
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error result")
    expect(result.reason).toBe("writes-disabled")
  })

  test("local mode runs linkFromFile over the bridge with the token", async () => {
    const reqs: Recorded[] = []
    const file = await tempFile("note.md", "# hello")
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch(
        {
          "localhost:23119/api": () => jsonResponse([]),
          "debug-bridge/execute": () => jsonResponse("ATTKEY"),
        },
        reqs,
      ),
    })
    await h.caller.science.library.connect({ kind: "zotero", mode: "local", bridgeToken: "tok" })
    const result = await h.caller.science.library.attachFile({ itemKey: "DOC1", filePath: file })
    expect(result).toEqual({ ok: true, attachmentKey: "ATTKEY" })

    const bridge = reqs.find((r) => r.url.includes("debug-bridge/execute"))
    if (!bridge) throw new Error("bridge not called")
    expect(headerOf(bridge.init, "Authorization")).toBe("Bearer tok")
    expect(headerOf(bridge.init, "Content-Type")).toBe("application/javascript")
    expect(String(bridge.init?.body)).toContain("linkFromFile")
    expect(String(bridge.init?.body)).toContain("DOC1")
  })

  test("web mode runs the 3-step upload; storage PUT carries no Zotero headers", async () => {
    const reqs: Recorded[] = []
    const file = await tempFile("note.md", "# hello world")
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch(
        {
          "/items?limit=1": () => jsonResponse([]), // connect probe
          "storage.example": () => jsonResponse({}, { ok: true }), // storage upload
          "/file": () =>
            jsonResponse({
              url: "https://storage.example/put",
              uploadKey: "UP1",
              prefix: "PRE",
              suffix: "SUF",
              contentType: "text/markdown",
            }),
          "/items": () => jsonResponse({ successful: { "0": { key: "ATT1" } } }), // create
        },
        reqs,
      ),
    })
    await h.caller.science.library.connect({
      kind: "zotero",
      mode: "web",
      apiKey: "wk",
      libraryType: "user",
      libraryId: "42",
    })
    const result = await h.caller.science.library.attachFile({ itemKey: "DOC1", filePath: file })
    expect(result).toEqual({ ok: true, attachmentKey: "ATT1" })

    // The create call carries the attachment shape (parent + imported_file + md5).
    const create = reqs.find((r) => r.url.endsWith("/items") && r.init?.method === "POST")
    if (!create) throw new Error("create not called")
    const created = JSON.parse(String(create.init?.body)) as Array<Record<string, unknown>>
    expect(created[0]).toMatchObject({
      itemType: "attachment",
      parentItem: "DOC1",
      linkMode: "imported_file",
    })
    expect(typeof created[0]?.md5).toBe("string")

    // The storage upload is a fresh request with NONE of the Zotero headers.
    const upload = reqs.find((r) => r.url.includes("storage.example"))
    if (!upload) throw new Error("upload not called")
    expect(headerOf(upload.init, "Zotero-API-Key")).toBeUndefined()
    expect(headerOf(upload.init, "Zotero-API-Version")).toBeUndefined()
  })

  test("web mode short-circuits when the file already exists in storage", async () => {
    const reqs: Recorded[] = []
    const file = await tempFile("note.md", "dup")
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch(
        {
          "/items?limit=1": () => jsonResponse([]),
          "/file": () => jsonResponse({ exists: 1 }),
          "/items": () => jsonResponse({ successful: { "0": { key: "ATT9" } } }),
        },
        reqs,
      ),
    })
    await h.caller.science.library.connect({
      kind: "zotero",
      mode: "web",
      apiKey: "wk",
      libraryType: "user",
      libraryId: "42",
    })
    const result = await h.caller.science.library.attachFile({ itemKey: "DOC1", filePath: file })
    expect(result).toEqual({ ok: true, attachmentKey: "ATT9" })
    // No storage upload happened on the dedup path.
    expect(reqs.every((r) => !r.url.includes("storage.example"))).toBe(true)
  })

  test("web mode surfaces a read-only-key 403 from the create step", async () => {
    const reqs: Recorded[] = []
    const file = await tempFile("note.md", "x")
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch(
        {
          "/items?limit=1": () => jsonResponse([]),
          "/items": () => jsonResponse(null, { ok: false, status: 403 }),
        },
        reqs,
      ),
    })
    await h.caller.science.library.connect({
      kind: "zotero",
      mode: "web",
      apiKey: "readonly",
      libraryType: "user",
      libraryId: "42",
    })
    const result = await h.caller.science.library.attachFile({ itemKey: "DOC1", filePath: file })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error result")
    expect(result.reason).toBe("error")
    expect(result.message).toContain("403")
    // No upload was attempted after the create rejection.
    expect(reqs.every((r) => !r.url.includes("storage.example"))).toBe(true)
  })

  test("web mode surfaces a per-item create failure message", async () => {
    const file = await tempFile("note.md", "x")
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch({
        "/items?limit=1": () => jsonResponse([]),
        "/items": () => jsonResponse({ failed: { "0": { message: "write access required" } } }),
      }),
    })
    await h.caller.science.library.connect({
      kind: "zotero",
      mode: "web",
      apiKey: "readonly",
      libraryType: "user",
      libraryId: "42",
    })
    const result = await h.caller.science.library.attachFile({ itemKey: "DOC1", filePath: file })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error result")
    expect(result.message).toContain("write access required")
  })

  test("local mode maps a missing parent item to a typed error", async () => {
    const file = await tempFile("note.md", "x")
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch({
        "localhost:23119/api": () => jsonResponse([]),
        "debug-bridge/execute": () => jsonResponse("ERR:no-parent"),
      }),
    })
    await h.caller.science.library.connect({ kind: "zotero", mode: "local", bridgeToken: "tok" })
    const result = await h.caller.science.library.attachFile({ itemKey: "MISSING", filePath: file })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error result")
    expect(result.message).toContain("not found")
  })
})

describe("science.library.listCollections", () => {
  test("returns a typed not-connected result when no creds are stored", async () => {
    h = await createHarness()
    expect(await h.caller.science.library.listCollections()).toEqual({
      ok: false,
      reason: "not-connected",
    })
  })

  test("lists top-level collections, then subcollections of a parent", async () => {
    const reqs: Recorded[] = []
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch(
        {
          "/items?limit=1": () => jsonResponse([]), // connect probe
          "/collections/top": () => jsonResponse(ZOTERO_COLLECTIONS),
          "/collections/COLL1/collections": () => jsonResponse([ZOTERO_COLLECTIONS[1]]),
        },
        reqs,
      ),
    })
    await h.caller.science.library.connect({
      kind: "zotero",
      mode: "web",
      apiKey: "k",
      libraryType: "user",
      libraryId: "42",
    })

    const top = await h.caller.science.library.listCollections()
    if (!top.ok) throw new Error("expected ok result")
    expect(top.collections).toHaveLength(2)
    expect(top.collections[0]).toMatchObject({
      key: "COLL1",
      name: "Methods",
      itemCount: 3,
      subcollectionCount: 1,
    })
    expect(reqs.some((r) => r.url.includes("/users/42/collections/top"))).toBe(true)

    const sub = await h.caller.science.library.listCollections({ parentKey: "COLL1" })
    if (!sub.ok) throw new Error("expected ok result")
    expect(sub.collections).toHaveLength(1)
    expect(reqs.some((r) => r.url.includes("/collections/COLL1/collections"))).toBe(true)
  })

  test("listItems scopes to a collection when collectionKey is set", async () => {
    const reqs: Recorded[] = []
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch(
        {
          "/items?limit=1": () => jsonResponse([]),
          "/collections/COLL1/items/top": () => jsonResponse(ZOTERO_ITEMS),
        },
        reqs,
      ),
    })
    await h.caller.science.library.connect({
      kind: "zotero",
      mode: "web",
      apiKey: "k",
      libraryType: "user",
      libraryId: "42",
    })
    const result = await h.caller.science.library.listItems({ collectionKey: "COLL1" })
    if (!result.ok) throw new Error("expected ok result")
    expect(result.items).toHaveLength(2)
    expect(reqs.some((r) => r.url.includes("/users/42/collections/COLL1/items/top"))).toBe(true)
  })
})
