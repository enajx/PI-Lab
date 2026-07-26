import { describe, expect, test } from "vitest"
import { escapeUnclosedMarkdownHtml } from "./vitepress-safe-markdown"

describe("escapeUnclosedMarkdownHtml", () => {
  test("renders an unclosed placeholder tag as literal text", () => {
    const placeholder = { type: "html_inline", content: "<number>" }

    escapeUnclosedMarkdownHtml([placeholder])

    expect(placeholder.type).toBe("text")
  })

  test("preserves paired HTML, void HTML, and code examples", () => {
    const opening = { type: "html_inline", content: "<span>" }
    const closing = { type: "html_inline", content: "</span>" }
    const lineBreak = { type: "html_inline", content: "<br>" }
    const component = { type: "html_inline", content: "<AgentHealth />" }
    const code = { type: "code_inline", content: "<not-a-tag>" }

    escapeUnclosedMarkdownHtml([opening, closing, lineBreak, component, code])

    expect(opening.type).toBe("html_inline")
    expect(closing.type).toBe("html_inline")
    expect(lineBreak.type).toBe("html_inline")
    expect(component.type).toBe("html_inline")
    expect(code.type).toBe("code_inline")
  })

  test("renders an unmatched closing tag as literal text", () => {
    const closing = { type: "html_inline", content: "</number>" }

    escapeUnclosedMarkdownHtml([closing])

    expect(closing.type).toBe("text")
  })
})
