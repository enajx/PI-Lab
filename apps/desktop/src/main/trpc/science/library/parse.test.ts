// Unit + property tests for the Library parsers (AGENTS.md §14). These are pure
// transforms over loose JSON, so they get example tests for the real API shapes
// plus fast-check properties for totality (never throw, always well-formed) on
// arbitrary inputs.
import fc from "fast-check"
import { describe, expect, test } from "vitest"
import { type LibraryPaper, parseSemanticScholarPapers, parseZoteroItems } from "./parse"

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

describe("parseSemanticScholarPapers", () => {
  test("maps the real search shape into papers", () => {
    const papers = parseSemanticScholarPapers({
      total: 1,
      data: [
        {
          paperId: "P1",
          title: "T",
          year: 2021,
          abstract: "abs",
          url: "https://u",
          authors: [{ name: "Grace Hopper" }],
          externalIds: { DOI: "10.2/y" },
        },
      ],
    })
    expect(papers).toEqual([
      {
        id: "P1",
        title: "T",
        authors: ["Grace Hopper"],
        year: 2021,
        itemType: "paper",
        doi: "10.2/y",
        url: "https://u",
        abstract: "abs",
      },
    ])
  })

  test("falls back to the DOI then an index for the id", () => {
    expect(
      parseSemanticScholarPapers({ data: [{ title: "x", externalIds: { DOI: "10.3/z" } }] })[0]?.id,
    ).toBe("10.3/z")
    expect(parseSemanticScholarPapers({ data: [{ title: "x" }] })[0]?.id).toBe("s2-0")
  })

  test("a payload without a data array parses to an empty list", () => {
    expect(parseSemanticScholarPapers(null)).toEqual([])
    expect(parseSemanticScholarPapers({})).toEqual([])
    expect(parseSemanticScholarPapers({ data: "no" })).toEqual([])
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

  test("parseSemanticScholarPapers never throws and always yields well-formed papers", () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const papers = parseSemanticScholarPapers(input)
        expect(Array.isArray(papers)).toBe(true)
        for (const paper of papers) assertWellFormed(paper)
      }),
    )
  })
})
