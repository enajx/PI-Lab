import { describe, expect, test } from "vitest"
import { splitFrontMatter } from "./front-matter"

describe("splitFrontMatter", () => {
  test("splits a leading YAML front matter block from the body", () => {
    expect(splitFrontMatter("---\ntitle: Diary\n---\n\n## 2026-11-11\n")).toEqual({
      frontMatter: "title: Diary",
      body: "\n## 2026-11-11\n",
      block: "---\ntitle: Diary\n---\n",
    })
  })

  test("reads a front matter with Windows line endings or blank lines before it", () => {
    expect(splitFrontMatter("---\r\ntitle: D\r\n---\r\n\r\nBody\r\n")).toEqual({
      frontMatter: "title: D",
      body: "\r\nBody\r\n",
      block: "---\r\ntitle: D\r\n---\r\n",
    })
    expect(splitFrontMatter("\n\n---\ntitle: D\n---")).toEqual({
      frontMatter: "title: D",
      body: "",
      block: "\n\n---\ntitle: D\n---",
    })
  })

  test("returns the whole text as body when there is no front matter", () => {
    expect(splitFrontMatter("# Title\n\n---\n\nText\n")).toEqual({
      frontMatter: null,
      body: "# Title\n\n---\n\nText\n",
      block: "",
    })
  })

  test("an unclosed block is not front matter", () => {
    expect(splitFrontMatter("---\ntitle: x\n")).toEqual({
      frontMatter: null,
      body: "---\ntitle: x\n",
      block: "",
    })
  })
})
