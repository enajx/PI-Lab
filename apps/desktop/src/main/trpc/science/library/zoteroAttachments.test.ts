// Unit tests for the pure Zotero attachment resolver (md/engineering/testing-and-build.md). These
// transform the loose `/items/{key}/children` payload and do on-disk path math, so they
// get example tests for the real API shapes per link mode with an injected fake dataDir
// (no homedir, no I/O).
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  parseZoteroAttachments,
  pickBestAttachment,
  resolveAttachmentPath,
  type ZoteroAttachment,
} from "./zoteroAttachments"

const DATA_DIR = "/data/Zotero"

describe("parseZoteroAttachments", () => {
  test("parses children into typed attachments", () => {
    const atts = parseZoteroAttachments([
      {
        key: "ATT1",
        data: {
          itemType: "attachment",
          linkMode: "imported_file",
          filename: "paper.pdf",
          contentType: "application/pdf",
          title: "Full Text",
        },
      },
      {
        key: "ATT2",
        data: { itemType: "attachment", linkMode: "linked_file", path: "/abs/x.pdf" },
      },
    ])
    expect(atts).toEqual([
      {
        key: "ATT1",
        linkMode: "imported_file",
        filename: "paper.pdf",
        contentType: "application/pdf",
        title: "Full Text",
        path: undefined,
      },
      {
        key: "ATT2",
        linkMode: "linked_file",
        path: "/abs/x.pdf",
        filename: undefined,
        contentType: undefined,
        title: undefined,
      },
    ])
  })

  test("drops non-attachment children (e.g. notes) and rows lacking a key or link mode", () => {
    const atts = parseZoteroAttachments([
      { key: "N1", data: { itemType: "note" } },
      { key: "A1", data: { itemType: "attachment" } }, // no linkMode
      { data: { itemType: "attachment", linkMode: "imported_file", key: "FALLBACK" } },
    ])
    // Only the third survives, taking its key from data.key as a fallback.
    expect(atts).toEqual([
      {
        key: "FALLBACK",
        linkMode: "imported_file",
        filename: undefined,
        path: undefined,
        contentType: undefined,
        title: undefined,
      },
    ])
  })

  test("tolerates a non-array payload (-> empty list)", () => {
    expect(parseZoteroAttachments(null)).toEqual([])
    expect(parseZoteroAttachments({ data: [] })).toEqual([])
    expect(parseZoteroAttachments("nope")).toEqual([])
  })
})

describe("resolveAttachmentPath", () => {
  const att = (over: Partial<ZoteroAttachment>): ZoteroAttachment => ({
    key: "K",
    linkMode: "imported_file",
    ...over,
  })

  test("linked_file uses an absolute data.path", () => {
    expect(
      resolveAttachmentPath(att({ linkMode: "linked_file", path: "/abs/x.pdf" }), DATA_DIR),
    ).toBe("/abs/x.pdf")
  })

  test("linked_file returns null for a relative / `attachments:` path", () => {
    expect(
      resolveAttachmentPath(att({ linkMode: "linked_file", path: "rel/x.pdf" }), DATA_DIR),
    ).toBeNull()
    expect(
      resolveAttachmentPath(att({ linkMode: "linked_file", path: "attachments:x.pdf" }), DATA_DIR),
    ).toBeNull()
    expect(resolveAttachmentPath(att({ linkMode: "linked_file" }), DATA_DIR)).toBeNull()
  })

  test("imported_file / imported_url resolve under {dataDir}/storage/{key}/{filename}", () => {
    expect(
      resolveAttachmentPath(
        att({ linkMode: "imported_file", key: "AK", filename: "p.pdf" }),
        DATA_DIR,
      ),
    ).toBe(join(DATA_DIR, "storage", "AK", "p.pdf"))
    expect(
      resolveAttachmentPath(
        att({ linkMode: "imported_url", key: "BK", filename: "snap.html" }),
        DATA_DIR,
      ),
    ).toBe(join(DATA_DIR, "storage", "BK", "snap.html"))
  })

  test("imported_file with no filename -> null", () => {
    expect(
      resolveAttachmentPath(att({ linkMode: "imported_file", key: "AK" }), DATA_DIR),
    ).toBeNull()
  })

  test("linked_url / unknown link modes -> null", () => {
    expect(resolveAttachmentPath(att({ linkMode: "linked_url" }), DATA_DIR)).toBeNull()
    expect(resolveAttachmentPath(att({ linkMode: "something_else" }), DATA_DIR)).toBeNull()
  })
})

describe("pickBestAttachment", () => {
  test("prefers a PDF over a non-PDF file attachment", () => {
    const html: ZoteroAttachment = { key: "H", linkMode: "imported_url", filename: "snap.html" }
    const pdf: ZoteroAttachment = {
      key: "P",
      linkMode: "imported_file",
      filename: "paper.pdf",
      contentType: "application/pdf",
    }
    expect(pickBestAttachment([html, pdf])?.key).toBe("P")
  })

  test("ignores linked_url (web links) and falls back to the first file attachment", () => {
    const link: ZoteroAttachment = { key: "L", linkMode: "linked_url" }
    const file: ZoteroAttachment = { key: "F", linkMode: "imported_file", filename: "data.csv" }
    expect(pickBestAttachment([link, file])?.key).toBe("F")
  })

  test("returns undefined when only web links remain", () => {
    expect(pickBestAttachment([{ key: "L", linkMode: "linked_url" }])).toBeUndefined()
    expect(pickBestAttachment([])).toBeUndefined()
  })
})
