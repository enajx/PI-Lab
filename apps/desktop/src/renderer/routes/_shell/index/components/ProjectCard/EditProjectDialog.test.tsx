import type { Project, ProjectMetadata } from "@pi-lab/local-db"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { EditProjectDialog } from "./EditProjectDialog"

/**
 * Component test for the "Edit project…" dialog's two reworked sections:
 *
 *   - Emoji tags now draw from a single GLOBAL palette (a renderer preference,
 *     persisted to localStorage). Chips are the union of the palette and the
 *     project's own tags; clicking toggles assignment for THIS project; "+" opens
 *     an emoji picker; right-click removes one from the palette.
 *   - External links are URL-only (no per-link label input); the stored `label`
 *     field is left untouched server-side but never collected here.
 *
 * The dialog needs no router/tRPC — only localStorage — so it renders standalone.
 */

function project(overrides: Partial<Project> & Pick<Project, "id" | "name">): Project {
  return {
    repoPath: `/tmp/${overrides.id}`,
    defaultBranch: "main",
    color: null,
    thumbnail: null,
    gradient: { seed: 1, palette: ["#FFC700"] },
    digitalRain: false,
    metadata: null,
    agentConfig: null,
    sortIndex: 0,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    lastOpenedAt: 0,
    ...overrides,
  }
}

function renderDialog(p: Project) {
  const onSave = vi.fn<(metadata: ProjectMetadata | null) => void>()
  const onClose = vi.fn()
  render(<EditProjectDialog project={p} onClose={onClose} onSave={onSave} />)
  return { onSave, onClose }
}

const chipFor = (emoji: string): HTMLElement =>
  screen.getByTestId("edit-project-emoji").querySelector<HTMLElement>(`[data-emoji="${emoji}"]`) ??
  (() => {
    throw new Error(`no chip for ${emoji}`)
  })()

beforeEach(() => {
  // Each test starts from the seeded (default) global palette.
  window.localStorage.clear()
})

describe("EditProjectDialog — emoji palette", () => {
  test("shows the UNION of the global palette and the project's own tags", () => {
    // 🧠 and 🔥 are on the project but NOT in the default seed — they must still show.
    renderDialog(project({ id: "e1", name: "A", metadata: { emojiTags: ["🧠", "🔥"] } }))

    const chips = screen.getAllByTestId("edit-project-emoji-choice")
    const emoji = chips.map((c) => c.getAttribute("data-emoji"))
    expect(emoji).toEqual(expect.arrayContaining(["🔬", "🧪", "🚀", "💡", "🧠", "🔥"]))

    // Active = assigned to this project.
    expect(chipFor("🧠").getAttribute("aria-pressed")).toBe("true")
    expect(chipFor("🔥").getAttribute("aria-pressed")).toBe("true")
    expect(chipFor("🔬").getAttribute("aria-pressed")).toBe("false")
  })

  test("clicking a chip toggles assignment for this project only (palette unchanged)", () => {
    const { onSave } = renderDialog(project({ id: "e2", name: "B", metadata: null }))

    // Assign a seeded emoji to this project.
    fireEvent.click(chipFor("🔬"))
    expect(chipFor("🔬").getAttribute("aria-pressed")).toBe("true")
    // The chip stays in the palette (still rendered), it's just assigned now.
    expect(chipFor("🧪").getAttribute("aria-pressed")).toBe("false")

    fireEvent.click(screen.getByTestId("edit-project-save"))
    expect(onSave).toHaveBeenCalledWith({ emojiTags: ["🔬"] })
  })

  test("the '+' control opens an emoji picker whose selection joins the palette and assigns it here", () => {
    const { onSave } = renderDialog(project({ id: "e3", name: "C", metadata: null }))

    fireEvent.click(screen.getByTestId("edit-project-emoji-add"))
    expect(screen.queryByTestId("edit-project-emoji-input")).toBeNull()
    const picker = screen.getByTestId("edit-project-emoji-picker")
    fireEvent.click(
      picker.querySelector<HTMLElement>('[data-emoji="🦾"]') ??
        (() => {
          throw new Error("no picker choice for 🦾")
        })(),
    )

    // The new emoji joins the palette, active (assigned) for this project.
    expect(chipFor("🦾").getAttribute("aria-pressed")).toBe("true")
    // It persisted into the global palette pref (shared across projects).
    expect(window.localStorage.getItem("pi-lab.emojiTagPalette")).toContain("🦾")

    fireEvent.click(screen.getByTestId("edit-project-save"))
    expect(onSave).toHaveBeenCalledWith({ emojiTags: ["🦾"] })
  })

  test("the picker includes the requested project-tag emoji", () => {
    renderDialog(project({ id: "e-requested", name: "Requested", metadata: null }))

    fireEvent.click(screen.getByTestId("edit-project-emoji-add"))
    const picker = screen.getByTestId("edit-project-emoji-picker")
    for (const emoji of ["💼", "🥭", "🐬", "☑️"]) {
      expect(picker.querySelector(`[data-emoji="${emoji}"]`)).not.toBeNull()
    }
  })

  test("right-clicking a chip removes it from the palette and unassigns it here", () => {
    const { onSave } = renderDialog(
      project({ id: "e4", name: "D", metadata: { emojiTags: ["🔬"] } }),
    )

    expect(chipFor("🔬").getAttribute("aria-pressed")).toBe("true")
    fireEvent.contextMenu(chipFor("🔬"))

    // Gone from the union of chips entirely (removed from palette AND unassigned).
    expect(screen.getByTestId("edit-project-emoji").querySelector('[data-emoji="🔬"]')).toBeNull()
    // The persisted palette no longer contains it.
    expect(window.localStorage.getItem("pi-lab.emojiTagPalette")).not.toContain("🔬")

    // Saving no longer includes it, and with nothing else set the group clears.
    fireEvent.click(screen.getByTestId("edit-project-save"))
    expect(onSave).toHaveBeenCalledWith(null)
  })
})

describe("EditProjectDialog — external links", () => {
  test("renders 'External links' with a URL-only row (no label input)", () => {
    renderDialog(
      project({
        id: "l1",
        name: "E",
        metadata: { referenceLinks: [{ url: "https://www.overleaf.com/project/x", label: "Old" }] },
      }),
    )

    expect(screen.getByText("External links")).toBeTruthy()
    expect(screen.queryByText("Reference links")).toBeNull()

    // The existing URL loads; there is no per-link label field anymore.
    const url = screen.getByTestId("edit-project-link-url") as HTMLInputElement
    expect(url.value).toBe("https://www.overleaf.com/project/x")
    expect(screen.queryByTestId("edit-project-link-label")).toBeNull()
    expect(url.getAttribute("placeholder")).toContain("overleaf.com")
  })

  test("saving a link keeps only its URL (label is not collected)", () => {
    const { onSave } = renderDialog(project({ id: "l2", name: "F", metadata: null }))

    fireEvent.click(screen.getByTestId("edit-project-link-add"))
    fireEvent.change(screen.getByTestId("edit-project-link-url"), {
      target: { value: "https://github.com/a/b" },
    })
    fireEvent.click(screen.getByTestId("edit-project-save"))

    expect(onSave).toHaveBeenCalledWith({ referenceLinks: [{ url: "https://github.com/a/b" }] })
  })
})
