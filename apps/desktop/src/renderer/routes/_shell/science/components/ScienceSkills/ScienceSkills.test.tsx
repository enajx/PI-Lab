import type { Project } from "@skipper/local-db"
import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { ScienceSkills } from "./ScienceSkills"

/**
 * Component test for the Skills science tab (AGENTS.md §14). The tab renders
 * plain DOM + hand-authored UI primitives, so jsdom suffices and we assert
 * structure only: skill cards, the source badge, the project selector, the
 * search filter, and the empty / no-projects states — never copy text or
 * shadcn classes.
 */

function renderSkills(handlers: FakeHandlers) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(handlers)
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <ScienceSkills />
    </AppProviders>,
  )
}

function project(overrides: Partial<Project> & Pick<Project, "id" | "name">): Project {
  return {
    repoPath: `/repos/${overrides.name}`,
    defaultBranch: "main",
    color: null,
    thumbnail: null,
    sortIndex: 0,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    lastOpenedAt: 0,
    ...overrides,
  }
}

function skill(name: string, source: string, description = "") {
  return { name, description, slug: name, path: `/repos/p/${source}/${name}/SKILL.md`, source }
}

describe("ScienceSkills", () => {
  test("renders a card per skill with its name and source badge", async () => {
    renderSkills({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.skills.list": () => [
        skill("deslop", ".claude/skills", "Clean up code."),
        skill("ticket-format", ".agents/skills", "Ticket spec."),
      ],
    })

    await waitFor(() => {
      expect(screen.getAllByTestId("skill-card")).toHaveLength(2)
    })
    const names = screen.getAllByTestId("skill-name").map((el) => el.textContent)
    expect(names).toEqual(["deslop", "ticket-format"])

    const sources = screen.getAllByTestId("skill-source").map((el) => el.textContent)
    expect(sources).toEqual([".claude/skills", ".agents/skills"])
  })

  test("defaults the selector to the most-recently-opened (first) project", async () => {
    renderSkills({
      "projects.list": () => [
        project({ id: "recent", name: "recent" }),
        project({ id: "older", name: "older" }),
      ],
      "science.skills.list": () => [skill("only", ".agents/skills")],
    })

    await waitFor(() => {
      expect(screen.getByTestId("skills-project-select")).toBeTruthy()
    })
    const select = screen.getByTestId("skills-project-select") as HTMLSelectElement
    expect(select.value).toBe("recent")
  })

  test("shows the empty state when the project has no skills", async () => {
    renderSkills({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.skills.list": () => [],
    })

    await waitFor(() => {
      expect(screen.getByTestId("science-skills-empty")).toBeTruthy()
    })
    expect(screen.queryByTestId("skill-card")).toBeNull()
  })

  test("shows the no-projects state when nothing is open", async () => {
    renderSkills({
      "projects.list": () => [],
    })

    await waitFor(() => {
      expect(screen.getByTestId("science-skills-no-projects")).toBeTruthy()
    })
    expect(screen.queryByTestId("skill-card")).toBeNull()
  })

  test("the search filter narrows the visible cards", async () => {
    renderSkills({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.skills.list": () => [
        skill("deslop", ".claude/skills", "Clean up code."),
        skill("ticket-format", ".agents/skills", "Ticket spec."),
      ],
    })

    await waitFor(() => {
      expect(screen.getAllByTestId("skill-card")).toHaveLength(2)
    })

    fireEvent.change(screen.getByTestId("skills-search"), { target: { value: "ticket" } })

    await waitFor(() => {
      expect(screen.getAllByTestId("skill-card")).toHaveLength(1)
    })
    expect(screen.getByTestId("skill-name").textContent).toBe("ticket-format")
  })
})
