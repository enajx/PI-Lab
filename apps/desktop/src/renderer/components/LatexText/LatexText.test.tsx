import { render, screen } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { LatexText } from "./LatexText"

describe("LatexText", () => {
  test("draws the word LaTeX as the stylised logo and keeps the rest as text", () => {
    const { container } = render(<LatexText text="LaTeX Editor" />)
    const logo = screen.getByTestId("latex-logo")
    expect(logo.getAttribute("aria-label")).toBe("LaTeX")
    // The raised A and lowered E are their own elements.
    expect(logo.querySelectorAll("span").length).toBe(2)
    expect(container.textContent?.endsWith(" Editor")).toBe(true)
  })

  test("text without LaTeX is unchanged", () => {
    const { container } = render(<LatexText text="Tasks" />)
    expect(screen.queryByTestId("latex-logo")).toBeNull()
    expect(container.textContent).toBe("Tasks")
  })
})
