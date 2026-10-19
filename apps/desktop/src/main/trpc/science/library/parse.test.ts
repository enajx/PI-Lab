// Unit + property tests for the Library parsers. These are pure
// transforms over loose JSON, so they get example tests for the real API shapes
// plus fast-check properties for totality (never throw, always well-formed) on
// arbitrary inputs.
import fc from "fast-check"
import { describe, expect, test } from "vitest"
import { type LibraryPaper, parseZoteroCollections, parseZoteroItems } from "./parse"

describe("parseZoteroItems", () => {
  test("maps the real item shape into papers", () => {
    const papers = parseZoteroItems([
      {
        key: "K1",
        data: {
          title: "A Paper",
          itemType: "journalArticle",
          date: "May 2019",
          DOI: "10.1/x",
          url: "https://x",
          creators: [{ firstName: "Ada", lastName: "Lovelace" }, { name: "Org" }],
          abstractNote: "An abstract.",
        },
      },
    ])
    expect(papers).toEqual([
      {
        id: "K1",
        title: "A Paper",
        authors: ["Ada Lovelace", "Org"],
        year: 2019,
        itemType: "journalArticle",
        doi: "10.1/x",
        url: "https://x",
        abstract: "An abstract.",
      },
    ])
  })

  test("degrades gracefully on missing fields", () => {
    const [paper] = parseZoteroItems([{ key: "K2", data: {} }])
    expect(paper).toMatchObject({ id: "K2", title: "(untitled)", authors: [] })
    expect(paper?.year).toBeUndefined()
    expect(paper?.doi).toBeUndefined()
  })

  test("a non-array payload parses to an empty list", () => {
    expect(parseZoteroItems(null)).toEqual([])
    expect(parseZoteroItems({ data: [] })).toEqual([])
    expect(parseZoteroItems("nope")).toEqual([])
  })

  test("synthesizes a stable id when the key is absent", () => {
    const papers = parseZoteroItems([{ data: { title: "no key" } }])
    expect(papers[0]?.id).toBe("zotero-0")
  })
})

describe("parseZoteroCollections", () => {
  test("maps the real collection shape with counts", () => {
    const cols = parseZoteroCollections([
      { key: "C1", data: { name: "Methods" }, meta: { numItems: 3, numCollections: 1 } },
    ])
    expect(cols[0]).toEqual({
      key: "C1",
      name: "Methods",
      itemCount: 3,
      subcollectionCount: 1,
    })
  })

  test("degrades gracefully and parses non-arrays to an empty list", () => {
    const [col] = parseZoteroCollections([{ key: "C2", data: {} }])
    expect(col).toMatchObject({ key: "C2", name: "(untitled collection)", itemCount: 0 })
    expect(parseZoteroCollections(null)).toEqual([])
    expect(parseZoteroCollections("nope")).toEqual([])
  })
})

/** Assert the universal invariants every parsed paper must satisfy. */
function assertWellFormed(paper: LibraryPaper): void {
  expect(typeof paper.id).toBe("string")
  expect(paper.id.length).toBeGreaterThan(0)
  expect(typeof paper.title).toBe("string")
  expect(paper.title.length).toBeGreaterThan(0)
  expect(Array.isArray(paper.authors)).toBe(true)
  for (const author of paper.authors) expect(typeof author).toBe("string")
  if (paper.year !== undefined) expect(Number.isFinite(paper.year)).toBe(true)
}

describe("parsers are total (property-based)", () => {
  test("parseZoteroItems never throws and always yields well-formed papers", () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const papers = parseZoteroItems(input)
        expect(Array.isArray(papers)).toBe(true)
        for (const paper of papers) assertWellFormed(paper)
      }),
    )
  })
})
