// Unit tests for the porcelain-v2 status parser — pure, no git invoked.
import { describe, expect, test } from "vitest"
import { parseStatusV2 } from "./parseStatus"

describe("parseStatusV2", () => {
  test("empty output is a clean tree", () => {
    expect(parseStatusV2("")).toEqual([])
  })

  test("an untracked file", () => {
    const out = "? new-file.txt\0"
    expect(parseStatusV2(out)).toEqual([
      { path: "new-file.txt", status: "untracked", staged: false, raw: "??" },
    ])
  })

  test("a staged add vs an unstaged modification", () => {
    // `1 A. …` = staged add; `1 .M …` = unstaged modify.
    const staged = "1 A. N... 000000 100644 100644 0000 abcd added.txt\0"
    const unstaged = "1 .M N... 100644 100644 100644 abcd abcd changed.txt\0"
    const parsed = parseStatusV2(staged + unstaged)
    expect(parsed).toEqual([
      { path: "added.txt", status: "added", staged: true, raw: "A." },
      { path: "changed.txt", status: "modified", staged: false, raw: ".M" },
    ])
  })

  test("a deletion", () => {
    const out = "1 .D N... 100644 100644 000000 abcd abcd gone.txt\0"
    expect(parseStatusV2(out)).toEqual([
      { path: "gone.txt", status: "deleted", staged: false, raw: ".D" },
    ])
  })

  test("a rename carries the original path from the trailing token", () => {
    const out = "2 R. N... 100644 100644 100644 abcd abcd R100 new-name.txt\0old-name.txt\0"
    expect(parseStatusV2(out)).toEqual([
      {
        path: "new-name.txt",
        originalPath: "old-name.txt",
        status: "renamed",
        staged: true,
        raw: "R.",
      },
    ])
  })

  test("an unmerged entry is conflicted", () => {
    // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` — 4 modes, 3 hashes.
    const out = "u UU N... 100644 100644 100644 100644 hash1 hash2 hash3 both.txt\0"
    expect(parseStatusV2(out)).toEqual([
      { path: "both.txt", status: "conflicted", staged: false, raw: "UU" },
    ])
  })

  test("mixed records parse in order, rename consuming its origin token", () => {
    const out =
      "1 M. N... 100644 100644 100644 abcd abcd staged-mod.txt\0" +
      "2 R. N... 100644 100644 100644 abcd abcd R100 to.txt\0from.txt\0" +
      "? untracked.txt\0"
    const parsed = parseStatusV2(out)
    expect(parsed.map((c) => c.path)).toEqual(["staged-mod.txt", "to.txt", "untracked.txt"])
    expect(parsed[1]?.originalPath).toBe("from.txt")
    expect(parsed[2]?.status).toBe("untracked")
  })
})
