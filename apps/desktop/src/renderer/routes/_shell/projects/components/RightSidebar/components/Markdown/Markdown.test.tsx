import { render, screen } from "@testing-library/react"
import { expect, test, vi } from "vitest"
import { Markdown } from "./Markdown"

const parseMarkdown = vi.hoisted(() => vi.fn())

// Count parsing through the real GFM plugin, retaining the actual Markdown renderer.
vi.mock("remark-gfm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("remark-gfm")>()
  parseMarkdown.mockImplementation(actual.default)
  return { default: parseMarkdown }
})

test("skips parsing unchanged content and renders changed Markdown with GFM styling", () => {
  const content = "# Research\n\n- [x] Done\n\n| Name | Value |\n| --- | --- |\n| Run | 1 |"
  const view = render(<Markdown content={content} />)
  const initialParses = parseMarkdown.mock.calls.length
  expect(initialParses).toBeGreaterThan(0)
  expect(screen.getByRole("heading", { name: "Research" }).className).toContain("font-semibold")
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true)
  expect(screen.getByRole("cell", { name: "Run" })).toBeTruthy()

  view.rerender(<Markdown content={content} />)
  expect(parseMarkdown).toHaveBeenCalledTimes(initialParses)

  view.rerender(<Markdown content={"## Updated\n\n[Reference](https://example.com)"} />)
  expect(parseMarkdown).toHaveBeenCalledTimes(initialParses + 1)
  expect(screen.getByRole("heading", { name: "Updated" })).toBeTruthy()
  expect(screen.getByRole("link", { name: "Reference" }).getAttribute("target")).toBe("_blank")
  expect(screen.getByRole("link", { name: "Reference" }).getAttribute("rel")).toBe("noreferrer")
})
