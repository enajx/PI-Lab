import { describe, expect, test } from "vitest"
import { splitFrontMatter } from "./front-matter"

describe("splitFrontMatter", () => {
  test("splits a leading YAML front matter block from the body", () => {
    expect(splitFrontMatter("---\ntitle: Diary\n---\n\n## 2026-11-11\n")).toEqual({
      frontMatter: "title: Diary",
      body: "\n## 2026-11-11\n",
    })
  })

  test("returns the whole text as body when there is no front matter", () => {
    expect(splitFrontMatter("# Title\n\n---\n\nText\n")).toEqual({
      frontMatter: null,
      body: "# Title\n\n---\n\nText\n",
    })
  })

  test("an unclosed block is not front matter", () => {
    expect(splitFrontMatter("---\ntitle: x\n")).toEqual({
      frontMatter: null,
      body: "---\ntitle: x\n",
    })
  })
})
