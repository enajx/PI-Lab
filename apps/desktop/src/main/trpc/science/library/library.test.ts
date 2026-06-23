// Integration tests for the science.library router via createCallerFactory over
// a temp SQLite DB with the real migrations (AGENTS.md §14). All outbound HTTP is
// the injected fake (`httpFetch`) so neither Zotero nor Semantic Scholar is ever
// hit; we assert credential persistence, parsing, and the typed not-connected /
// error outcomes.
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import type { HttpFetch } from "../../context"
import { createHarness, FAKE_AGENT, type Harness } from "../../testHarness"

/** Build a `Response`-like fake from a JSON body + status, for the injected fetch. */
function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const status = init.status ?? 200
  const ok = init.ok ?? (status >= 200 && status < 300)
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
  } as Response
}

/** A fetch fake that records called URLs and routes them to canned responses. */
function stubFetch(routes: Record<string, () => Response>, calls: string[] = []): HttpFetch {
  return async (input) => {
    const url = String(input)
    calls.push(url)
    for (const [needle, make] of Object.entries(routes)) {
      if (url.includes(needle)) return make()
    }
    throw new TypeError(`fetch failed: no stub for ${url}`)
  }
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

const S2_SEARCH = {
  total: 1,
  data: [
    {
      paperId: "p1",
      title: "Deep Residual Learning",
      year: 2016,
      abstract: "We present a residual learning framework…",
      url: "https://example.org/resnet",
      authors: [{ name: "Kaiming He" }, { name: "Xiangyu Zhang" }],
      externalIds: { DOI: "10.1109/CVPR.2016.90" },
    },
  ],
}

let h: Harness

afterEach(async () => {
  await h?.dispose()
})

describe("science.library connect / getStatus / disconnect", () => {
  beforeEach(async () => {
    // connect runs a one-item probe before persisting; stub it as reachable.
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch({ "api.zotero.org": () => jsonResponse([]) }),
    })
  })

  test("getStatus reports not connected on a fresh DB", async () => {
    expect(await h.caller.science.library.getStatus()).toEqual({ connected: false })
  })

  test("connect persists creds; getStatus reflects them sans the key", async () => {
    const status = await h.caller.science.library.connect({
      apiKey: "secret-key",
      libraryType: "user",
      libraryId: "123456",
    })
    expect(status).toEqual({ connected: true, libraryType: "user", libraryId: "123456" })

    const after = await h.caller.science.library.getStatus()
    expect(after).toEqual({ connected: true, libraryType: "user", libraryId: "123456" })
    // The status surface never carries the API key.
    expect(JSON.stringify(after)).not.toContain("secret-key")
  })

  test("disconnect clears the stored connection", async () => {
    await h.caller.science.library.connect({
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
      h.caller.science.library.connect({ apiKey: "bad", libraryType: "user", libraryId: "1" }),
    ).rejects.toThrow(/403/)
    expect((await h.caller.science.library.getStatus()).connected).toBe(false)
  })
})

describe("science.library.listItems", () => {
  test("returns a typed not-connected result when no creds are stored", async () => {
    h = await createHarness()
    const result = await h.caller.science.library.listItems({})
    expect(result).toEqual({ ok: false, reason: "not-connected" })
  })

  test("parses a mocked Zotero response into papers", async () => {
    const calls: string[] = []
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch(
        {
          // probe (connect) and the top-items list both match this host.
          "/items?limit=1": () => jsonResponse([]),
          "/items/top": () => jsonResponse(ZOTERO_ITEMS),
        },
        calls,
      ),
    })
    await h.caller.science.library.connect({
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
    expect(calls.some((u) => u.includes("/users/42/items/top"))).toBe(true)
    expect(calls.every((u) => !u.includes("k"))).toBe(true)
  })

  test("a fetch error surfaces as a typed error result (no throw)", async () => {
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch({
        "/items?limit=1": () => jsonResponse([]),
        "/items/top": () => jsonResponse(null, { ok: false, status: 500 }),
      }),
    })
    await h.caller.science.library.connect({ apiKey: "k", libraryType: "user", libraryId: "1" })

    const result = await h.caller.science.library.listItems({})
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error result")
    expect(result.reason).toBe("error")
    expect(result.message).toContain("500")
  })
})

describe("science.library.searchPapers", () => {
  test("parses a mocked Semantic Scholar response into papers", async () => {
    const calls: string[] = []
    h = await createHarness([FAKE_AGENT], {
      httpFetch: stubFetch({ "semanticscholar.org": () => jsonResponse(S2_SEARCH) }, calls),
    })
    const result = await h.caller.science.library.searchPapers({ query: "resnet" })
    if (!result.ok) throw new Error("expected ok result")
    expect(result.papers).toHaveLength(1)
    expect(result.papers[0]).toMatchObject({
      id: "p1",
      title: "Deep Residual Learning",
      authors: ["Kaiming He", "Xiangyu Zhang"],
      year: 2016,
      doi: "10.1109/CVPR.2016.90",
    })
    // Polite, bounded query: small limit + an explicit field set.
    expect(calls[0]).toContain("/paper/search")
    expect(calls[0]).toContain("limit=20")
    expect(calls[0]).toContain("query=resnet")
  })

  test("a network failure surfaces as a typed error (no throw)", async () => {
    h = await createHarness([FAKE_AGENT], {
      httpFetch: async () => {
        throw new TypeError("network down")
      },
    })
    const result = await h.caller.science.library.searchPapers({ query: "x" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error result")
    expect(result.message).toContain("network down")
  })
})
