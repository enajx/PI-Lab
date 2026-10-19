import type { Project } from "@pi-lab/local-db"
import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, test } from "vitest"
import { setInterfaceLanguage } from "../../../../../i18n/language"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { ScienceSkills } from "./ScienceSkills"

/**
 * Component test for the Skills science tab. The tab renders
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
    gradient: null,
    digitalRain: false,
    metadata: null,
    taskRelPath: null,
    mainRelPath: null,
    typeId: "general",
    agentConfig: null,
    sortIndex: 0,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    lastOpenedAt: 0,
    ...overrides,
  }
}

function skill(
  name: string,
  source: ".claude/skills" | ".agents/skills" | "~/.codex/skills",
  description = "",
) {
  const scope = source.startsWith("~/") ? ("global" as const) : ("project" as const)
  const harness = source.includes("claude")
    ? ("claude" as const)
    : source.includes("codex")
      ? ("codex" as const)
      : ("agents" as const)
  return {
    name,
    description,
    slug: name,
    path: `${scope === "global" ? "/home/user" : "/repos/p"}/${source.replace("~/", "")}/${name}/SKILL.md`,
    source,
    scope,
    harness,
  }
}

function catalog(skills: ReturnType<typeof skill>[]) {
  return { skills, roots: [] }
}

describe("ScienceSkills", () => {
  afterEach(() => setInterfaceLanguage("en"))

  test("translates the Skills empty state when the interface language changes", async () => {
    setInterfaceLanguage("es")
    renderSkills({ "projects.list": () => [] })
    expect(await screen.findByText("No hay proyectos abiertos")).toBeTruthy()
  })

  test("renders a card per skill with its name and source badge", async () => {
    renderSkills({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.skills.list": () =>
        catalog([
          skill("deslop", ".claude/skills", "Clean up code."),
          skill("ticket-format", ".agents/skills", "Ticket spec."),
        ]),
    })

    await waitFor(() => {
      expect(screen.getAllByTestId("skill-card")).toHaveLength(2)
    })
    const names = screen.getAllByTestId("skill-name").map((el) => el.textContent)
    expect(names).toEqual(["deslop", "ticket-format"])

    const sources = screen.getAllByTestId("skill-source").map((el) => el.textContent)
    expect(sources).toEqual([".claude/skills", ".agents/skills"])
    expect(screen.getAllByTestId("skill-scope").map((el) => el.textContent)).toEqual([
      "Project-local",
      "Project-local",
    ])
  })

  test("defaults the selector to the most-recently-opened (first) project", async () => {
    renderSkills({
      "projects.list": () => [
        project({ id: "recent", name: "recent" }),
        project({ id: "older", name: "older" }),
      ],
      "science.skills.list": () => catalog([skill("only", ".agents/skills")]),
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
      "science.skills.list": () => catalog([]),
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
      "science.skills.list": () =>
        catalog([
          skill("deslop", ".claude/skills", "Clean up code."),
          skill("ticket-format", ".agents/skills", "Ticket spec."),
        ]),
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

  test("scope controls filter independently and persist for every Skills view", async () => {
    renderSkills({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.skills.list": () =>
        catalog([
          skill("project-skill", ".agents/skills"),
          skill("global-skill", "~/.codex/skills"),
        ]),
    })

    await waitFor(() => expect(screen.getAllByTestId("skill-card")).toHaveLength(2))
    fireEvent.click(screen.getByTestId("skills-show-project"))

    await waitFor(() => expect(screen.getAllByTestId("skill-card")).toHaveLength(1))
    expect(screen.getByTestId("skill-name").textContent).toBe("global-skill")
    expect(window.localStorage.getItem("pi-lab.skills.showProjectLocal")).toBe("false")
    expect(screen.getByTestId("skills-show-global").getAttribute("aria-checked")).toBe("true")
  })

  test("switching projects indexes and renders only the newly selected project", async () => {
    const requested: string[] = []
    renderSkills({
      "projects.list": () => [
        project({ id: "p1", name: "alpha" }),
        project({ id: "p2", name: "beta" }),
      ],
      "science.skills.list": (input) => {
        const projectId = (input as { projectId: string }).projectId
        requested.push(projectId)
        return catalog([skill(projectId === "p1" ? "alpha-skill" : "beta-skill", ".agents/skills")])
      },
    })

    await screen.findByText("alpha-skill")
    fireEvent.change(screen.getByTestId("skills-project-select"), { target: { value: "p2" } })
    await screen.findByText("beta-skill")

    expect(requested).toContain("p1")
    expect(requested).toContain("p2")
    expect(screen.queryByText("alpha-skill")).toBeNull()
  })

  test("surfaces query failures and partial-root warnings clearly", async () => {
    const view = renderSkills({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.skills.list": async () => {
        throw new Error("skill index unavailable")
      },
    })

    expect((await screen.findByTestId("science-skills-error")).textContent).toContain(
      "skill index unavailable",
    )
    view.unmount()

    renderSkills({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.skills.list": () => ({
        skills: [skill("partial", ".agents/skills")],
        roots: [
          {
            source: "~/.codex/skills" as const,
            harness: "codex" as const,
            scope: "global" as const,
            path: "/home/user/.codex/skills",
            status: "unreadable" as const,
            detail: "Could not read ~/.codex/skills: permission denied",
          },
        ],
      }),
    })

    expect((await screen.findByTestId("science-skills-warnings")).textContent).toContain(
      "permission denied",
    )
    expect(screen.getByText("partial")).toBeTruthy()
  })

  test("⌘F opens a finder over the skills; picking one highlights its card", async () => {
    renderSkills({
      "projects.list": () => [project({ id: "p1", name: "alpha" })],
      "science.skills.list": () =>
        catalog([
          skill("deslop", ".claude/skills", "Clean up code."),
          skill("ticket-format", ".agents/skills", "Ticket spec."),
        ]),
    })

    await waitFor(() => {
      expect(screen.getAllByTestId("skill-card")).toHaveLength(2)
    })

    // The quick-open shortcut (⌘F) opens the finder over this tab's skills (not projects).
    fireEvent.keyDown(window, { key: "f", metaKey: true })
    expect(screen.getByTestId("quick-find")).toBeTruthy()
    const finderItems = screen.getAllByTestId("quick-find-item")
    expect(finderItems.map((el) => el.getAttribute("data-find-id"))).toEqual([
      "/repos/p/.claude/skills/deslop/SKILL.md",
      "/repos/p/.agents/skills/ticket-format/SKILL.md",
    ])

    // Picking a skill closes the finder and highlights that card.
    const pick = finderItems.find(
      (el) => el.getAttribute("data-find-id") === "/repos/p/.agents/skills/ticket-format/SKILL.md",
    )
    if (!pick) throw new Error("expected the ticket-format skill in the finder")
    fireEvent.click(pick)

    expect(screen.queryByTestId("quick-find")).toBeNull()
    const cards = screen.getAllByTestId("skill-card")
    const selected = cards.filter((el) => el.getAttribute("data-selected") === "true")
    expect(selected).toHaveLength(1)
    expect(selected[0]?.getAttribute("data-skill")).toBe("ticket-format")
  })
})
