import { render, screen, within } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { setInterfaceLanguage } from "../../../i18n/language"
import { ProjectDiff } from "./ProjectDiff"

describe("project file review", () => {
  test("translates the empty review state", () => {
    setInterfaceLanguage("es")
    render(<ProjectDiff title="RESEARCH.md" original="" proposed="" />)
    expect(screen.getByText("(archivo nuevo vacío)")).toBeTruthy()
    setInterfaceLanguage("en")
  })
  test("marks added and removed lines while preserving unchanged context", () => {
    render(
      <ProjectDiff
        title="RESEARCH.md"
        original={"# Project\nOld question\nKeep this\n"}
        proposed={"# Project\nNew question\nKeep this\nAdded detail\n"}
      />,
    )
    const diff = screen.getByRole("region", { name: "RESEARCH.md diff" })
    expect(within(diff).getByText("Old question").getAttribute("data-change")).toBe("removed")
    expect(within(diff).getByText("New question").getAttribute("data-change")).toBe("added")
    expect(within(diff).getByText("Added detail").getAttribute("data-change")).toBe("added")
    expect(within(diff).getByText("Keep this").getAttribute("data-change")).toBe("unchanged")
  })
})
