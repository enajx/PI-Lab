import type { Project, ProjectDetails } from "@pi-lab/local-db"
import { QueryClient } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { setInterfaceLanguage } from "../../../../../i18n/language"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient } from "../../../../../test/fakeTrpcClient"
import { EditProjectDialog } from "./EditProjectDialog"

/** Exercises the shared project form with a fake IPC client. */
function project(overrides: Partial<Project> & Pick<Project, "id" | "name">): Project {
  return {
    repoPath: `/tmp/${overrides.id}`,
    defaultBranch: "main",
    color: null,
    thumbnail: null,
    gradient: { seed: 1, palette: ["#FFC700"] },
    digitalRain: false,
    metadata: null,
    taskRelPath: null,
    mainRelPath: null,
    typeId: "research",
    agentConfig: null,
    sortIndex: 0,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    lastOpenedAt: 0,
    ...overrides,
  }
}

function renderDetails(p: Project, mode: "add" | "edit", storedAgentId: string | null) {
  const onSave = vi.fn<(metadata: ProjectDetails | null) => void>()
  const onClose = vi.fn()
  render(
    <AppProviders
      client={createFakeTrpcClient({
        "agents.list": () => [
          { id: "codex", label: "Codex", available: true },
          { id: "missing", label: "Missing", available: false },
        ],
        "agents.projectChoice": () => ({ agentId: storedAgentId }),
      })}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <EditProjectDialog
        mode={mode}
        project={p}
        pending={false}
        error={null}
        onClose={onClose}
        onSave={onSave}
      />
    </AppProviders>,
  )
  return { onSave, onClose }
}

function renderDialog(p: Project) {
  return renderDetails(p, "edit", null)
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
  test("updates the dialog copy when the interface language changes", () => {
    renderDialog(project({ id: "localized", name: "Study", metadata: null }))
    act(() => setInterfaceLanguage("es"))
    expect(screen.getByRole("heading", { name: "Editar proyecto" })).toBeTruthy()
    expect(screen.queryByTestId("edit-project-collaborators")).toBeNull()
    act(() => setInterfaceLanguage("en"))
  })

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

  test("clicking a chip toggles assignment for this project only (palette unchanged)", async () => {
    const { onSave } = renderDialog(project({ id: "e2", name: "B", metadata: null }))

    // Assign a seeded emoji to this project.
    fireEvent.click(chipFor("🔬"))
    expect(chipFor("🔬").getAttribute("aria-pressed")).toBe("true")
    // The chip stays in the palette (still rendered), it's just assigned now.
    expect(chipFor("🧪").getAttribute("aria-pressed")).toBe("false")

    await waitFor(() =>
      expect((screen.getByTestId("edit-project-save") as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId("edit-project-save"))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ emojiTags: ["🔬"] }))
  })

  test("the '+' control opens an emoji picker whose selection joins the palette and assigns it here", async () => {
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

    await waitFor(() =>
      expect((screen.getByTestId("edit-project-save") as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId("edit-project-save"))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ emojiTags: ["🦾"] }))
  })

  test("the picker includes the requested project-tag emoji", () => {
    renderDialog(project({ id: "e-requested", name: "Requested", metadata: null }))

    fireEvent.click(screen.getByTestId("edit-project-emoji-add"))
    const picker = screen.getByTestId("edit-project-emoji-picker")
    for (const emoji of ["💼", "🥭", "🐬", "☑️"]) {
      expect(picker.querySelector(`[data-emoji="${emoji}"]`)).not.toBeNull()
    }
  })

  test("right-clicking a chip removes it from the palette and unassigns it here", async () => {
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
    await waitFor(() =>
      expect((screen.getByTestId("edit-project-save") as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId("edit-project-save"))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ emojiTags: [] }))
  })
})

describe("project details", () => {
  test("edits name, type, deadline and text tags without exposing retired fields", async () => {
    const { onSave } = renderDialog(
      project({
        id: "details",
        name: "Folder",
        metadata: {
          collaborators: "Old",
          venue: "Old",
          referenceLinks: [{ url: "https://example.com" }],
        },
      }),
    )
    expect(screen.getByText("Tags")).toBeTruthy()
    expect(screen.queryByText("Emoji tags")).toBeNull()
    expect(screen.queryByText(/Click to tag this project/)).toBeNull()
    expect(screen.queryByText("Collaborators")).toBeNull()
    expect(screen.queryByText("Publishing venue")).toBeNull()
    expect(screen.queryByText("External links")).toBeNull()
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "New title" } })
    fireEvent.change(screen.getByLabelText("Project type"), { target: { value: "manuscript" } })
    fireEvent.change(screen.getByLabelText("Deadline"), { target: { value: "2026-12-01" } })
    fireEvent.change(screen.getByLabelText("Text tag"), { target: { value: "Priority" } })
    expect(screen.queryByLabelText("Tag color")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Add tag" }))
    await waitFor(() =>
      expect((screen.getByTestId("edit-project-save") as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId("edit-project-save"))
    expect(onSave).toHaveBeenCalledWith({
      name: "New title",
      typeId: "manuscript",
      deadline: "2026-12-01",
      agentId: null,
      emojiTags: [],
      textTags: [{ label: "Priority", color: "blue" }],
    })
  })
})

test("Add uses an unselected type and keeps Plan research disabled", async () => {
  const { onSave, onClose } = renderDetails(
    project({ id: "new", name: "folder-name", typeId: "general" }),
    "add",
    null,
  )
  expect(screen.queryByLabelText("Deadline")).toBeNull()
  expect(screen.queryByText("Tags")).toBeNull()
  expect(screen.queryByTestId("edit-project-tag-text")).toBeNull()
  expect((screen.getByLabelText("Project name") as HTMLInputElement).value).toBe("folder-name")
  expect(
    (screen.getByRole("button", { name: "Plan research" }) as HTMLButtonElement).disabled,
  ).toBe(true)
  expect(screen.queryByLabelText("Project type")).toBeNull()
  expect((screen.getByTestId("add-project-confirm") as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByTestId("add-project-confirm"))
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ typeId: "general", agentId: null, deadline: null }),
  )
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  expect(onClose).toHaveBeenCalledOnce()
})

test("Edit loads the saved agent choice and can reset it to Settings default", async () => {
  const { onSave } = renderDetails(
    project({ id: "configured", name: "Configured", agentConfig: { agentId: "missing" } }),
    "edit",
    "codex",
  )
  await waitFor(() =>
    expect((screen.getByLabelText("Agent") as HTMLSelectElement).value).toBe("codex"),
  )
  expect(screen.queryByRole("option", { name: "Missing" })).toBeNull()
  fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "" } })
  fireEvent.change(screen.getByLabelText("Project type"), { target: { value: "" } })
  fireEvent.click(screen.getByTestId("edit-project-save"))
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ agentId: null, typeId: "general" }))
})
