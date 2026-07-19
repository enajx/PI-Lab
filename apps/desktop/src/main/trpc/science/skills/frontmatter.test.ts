// Unit tests for the SKILL.md frontmatter parser (md/engineering/testing-and-build.md). The parser is
// pure and total — it never throws and always returns a well-formed result — so
// these cover the real authored shape plus the degenerate inputs (missing
// fields, no block, unterminated block, CRLF, blank values).
import { describe, expect, test } from "vitest"
import { parseSkillFrontmatter } from "./frontmatter"

describe("parseSkillFrontmatter", () => {
  test("reads name and description from a well-formed block", () => {
    const content = [
      "---",
      "name: ticket-format",
      "description: How we structure tickets in this repo.",
      "---",
      "",
      "# Ticket format",
      "body…",
    ].join("\n")
    expect(parseSkillFrontmatter(content)).toEqual({
      name: "ticket-format",
      description: "How we structure tickets in this repo.",
    })
  })

  test("ignores unknown keys and is case-insensitive on keys", () => {
    const content = [
      "---",
      "Name: deslop",
      "model: opus",
      "DESCRIPTION: Clean up code.",
      "---",
    ].join("\n")
    expect(parseSkillFrontmatter(content)).toEqual({
      name: "deslop",
      description: "Clean up code.",
    })
  })

  test("defaults a missing field to an empty string", () => {
    const content = ["---", "name: only-name", "---", "body"].join("\n")
    expect(parseSkillFrontmatter(content)).toEqual({ name: "only-name", description: "" })
  })

  test("returns empty fields when there is no frontmatter at all", () => {
    expect(parseSkillFrontmatter("# Just a heading\n\nNo frontmatter here.")).toEqual({
      name: "",
      description: "",
    })
  })

  test("ignores an unterminated frontmatter block (safe, no throw)", () => {
    const content = ["---", "name: never-closed", "description: dangling"].join("\n")
    expect(parseSkillFrontmatter(content)).toEqual({ name: "", description: "" })
  })

  test("only the leading block counts — a later '---' is not frontmatter", () => {
    const content = ["# Heading", "", "---", "name: not-frontmatter", "---"].join("\n")
    expect(parseSkillFrontmatter(content)).toEqual({ name: "", description: "" })
  })

  test("tolerates CRLF line endings", () => {
    const content = ["---", "name: crlf-skill", "description: works", "---", "body"].join("\r\n")
    expect(parseSkillFrontmatter(content)).toEqual({ name: "crlf-skill", description: "works" })
  })

  test("trims surrounding whitespace from values and collapses blank values", () => {
    const content = ["---", "name:    spaced   ", "description:   ", "---"].join("\n")
    expect(parseSkillFrontmatter(content)).toEqual({ name: "spaced", description: "" })
  })

  test("never throws on empty input", () => {
    expect(parseSkillFrontmatter("")).toEqual({ name: "", description: "" })
  })
})
