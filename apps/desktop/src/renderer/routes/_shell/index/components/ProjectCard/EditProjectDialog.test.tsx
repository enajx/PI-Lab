import type { Project, ProjectDetails } from "@pi-lab/local-db"
import { QueryClient } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { setInterfaceLanguage } from "../../../../../i18n/language"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
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
    sortOrder: null,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    lastOpenedAt: 0,
    ...overrides,
  }
}

function renderDetails(p: Project, mode: "add" | "edit", storedAgentId: string | null) {
  return renderDetailsWith(p, mode, storedAgentId, {
    "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null, autoDetect: true }),
  })
}

/** {@link renderDetails} with extra fake procedures (the paper folder ones). */
function renderDetailsWith(
  p: Project,
  mode: "add" | "edit",
  storedAgentId: string | null,
  extra: FakeHandlers,
) {
  const onSave = vi.fn<(metadata: ProjectDetails | null) => void>()
  const onClose = vi.fn()
  render(
    <AppProviders
      client={createFakeTrpcClient({
        ...extra,
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
      analysisFormat: null,
    })
  })

  test("sets and clears the project's analysis format override", async () => {
    const { onSave } = renderDialog(
      project({ id: "fmt", name: "Study", metadata: { analysisFormat: "qmd" } }),
    )
    const select = screen.getByLabelText("Analysis format") as HTMLSelectElement
    expect(select.value).toBe("qmd")
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Use default from Settings",
      "Markdown",
      "Quarto",
      "MyST Markdown",
      "HTML",
      "marimo notebook",
      "Jupyter notebook",
    ])
    await waitFor(() =>
      expect((screen.getByTestId("edit-project-save") as HTMLButtonElement).disabled).toBe(false),
    )

    fireEvent.change(select, { target: { value: "ipynb" } })
    fireEvent.click(screen.getByTestId("edit-project-save"))
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ analysisFormat: "ipynb" }))

    fireEvent.change(select, { target: { value: "" } })
    fireEvent.click(screen.getByTestId("edit-project-save"))
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ analysisFormat: null }))
  })
})

test("Edit project has a Project status row that sets the stage on click", async () => {
  const calls: unknown[] = []
  renderDetailsWith(
    project({ id: "p1", name: "Study", metadata: { stage: "planning" } }),
    "edit",
    null,
    {
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null, autoDetect: true }),
      "projects.setStage": (input) => {
        calls.push(input)
        return { id: "p1" }
      },
    },
  )
  const row = screen.getByTestId("edit-project-stage")
  expect(row.parentElement?.firstElementChild?.textContent).toBe("Project status")
  expect(
    within(row).getByTestId("edit-project-stage-step-planning").getAttribute("aria-current"),
  ).toBe("step")
  fireEvent.click(within(row).getByTestId("edit-project-stage-step-experiments"))
  await waitFor(() => expect(calls).toEqual([{ id: "p1", stage: "experiments" }]))
})

test("Add project has no Project status row", () => {
  renderDetails(project({ id: "p1", name: "Study" }), "add", null)
  expect(screen.queryByTestId("edit-project-stage")).toBeNull()
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

/** A paper folder state as `paper.get` returns it, or no folder when `displayDir` is null. */
function paperGet(displayDir: string | null) {
  return () =>
    displayDir === null
      ? { paper: null, workspaceId: null, rootRelPath: null, autoDetect: true }
      : {
          paper: { dir: "/real/paper", displayDir, syncEnabled: true },
          workspaceId: "ws",
          rootRelPath: "main.tex",
          autoDetect: true,
        }
}

describe("Paper folder row (mocked server)", () => {
  test("shows the current folder, the project folder, or None (with no Clear)", async () => {
    for (const [displayDir, shown] of [
      ["paper", "paper"],
      [".", "Project folder"],
      ["~/papers/x", "~/papers/x"],
      [null, "None"],
    ] as const) {
      renderDetailsWith(project({ id: "pf", name: "P" }), "edit", null, {
        "paper.get": paperGet(displayDir),
      })
      await waitFor(() =>
        expect(screen.getByTestId("edit-project-paper-folder").textContent).toBe(shown),
      )
      expect(screen.getByTestId("edit-project-paper-choose").textContent).toBe("Choose…")
      if (displayDir === null) expect(screen.queryByTestId("edit-project-paper-clear")).toBeNull()
      else expect(screen.getByTestId("edit-project-paper-clear").textContent).toBe("Clear")
      cleanup()
    }
  })

  test("is not shown when adding a project", () => {
    renderDetails(project({ id: "new", name: "N" }), "add", null)
    expect(screen.queryByTestId("edit-project-paper-folder")).toBeNull()
  })

  test("Choose sets the folder when the dialog is saved, not before", async () => {
    const link = vi.fn(() => ({ paper: null, workspaceId: null, rootRelPath: null }))
    const { onSave } = renderDetailsWith(project({ id: "pf", name: "P" }), "edit", null, {
      "paper.get": paperGet(null),
      "system.pickDirectory": () => "/Users/me/papers/x",
      "paper.checkFolder": () => ({
        displayDir: "~/papers/x",
        projectFolder: false,
        overleaf: false,
        remoteUrl: null,
        isPaper: true,
        inside: [],
        stoppedEarly: false,
      }),
      "paper.link": link,
    })
    fireEvent.click(await screen.findByTestId("edit-project-paper-choose"))
    await waitFor(() =>
      expect(screen.getByTestId("edit-project-paper-folder").textContent).toBe("~/papers/x"),
    )
    expect(link).not.toHaveBeenCalled()
    await waitFor(() =>
      expect((screen.getByTestId("edit-project-save") as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId("edit-project-save"))
    await waitFor(() =>
      expect(link).toHaveBeenCalledWith({
        projectId: "pf",
        dir: "/Users/me/papers/x",
        rootChoice: null,
      }),
    )
    await waitFor(() => expect(onSave).toHaveBeenCalled())
  })

  test("choosing the project folder asks with the project-folder pop-up, and saves the choice", async () => {
    const link = vi.fn(() => ({ paper: null, workspaceId: null, rootRelPath: null }))
    renderDetailsWith(project({ id: "pf", name: "P" }), "edit", null, {
      "paper.get": paperGet("paper"),
      "system.pickDirectory": () => "/proj",
      "paper.checkFolder": () => ({
        displayDir: ".",
        projectFolder: true,
        overleaf: false,
        remoteUrl: null,
        isPaper: true,
        inside: [],
        stoppedEarly: false,
      }),
      "paper.link": link,
    })
    fireEvent.click(await screen.findByTestId("edit-project-paper-choose"))
    const dialog = await screen.findByTestId("paper-root-dialog")
    expect(within(dialog).getByTestId("paper-root-other")).toBeTruthy()
    fireEvent.click(within(dialog).getByTestId("paper-root-no-sync"))
    await waitFor(() =>
      expect(screen.getByTestId("edit-project-paper-folder").textContent).toBe("Project folder"),
    )
    await waitFor(() =>
      expect((screen.getByTestId("edit-project-save") as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId("edit-project-save"))
    await waitFor(() =>
      expect(link).toHaveBeenCalledWith({ projectId: "pf", dir: "/proj", rootChoice: "no-sync" }),
    )
  })

  test("a chosen folder that is not a paper shows the papers inside it; the project folder from the list still asks first", async () => {
    const link = vi.fn(() => ({ paper: null, workspaceId: null, rootRelPath: null }))
    renderDetailsWith(project({ id: "pf", name: "P" }), "edit", null, {
      "paper.get": paperGet(null),
      "system.pickDirectory": () => "/Users/me",
      "paper.checkFolder": (input) =>
        (input as { dir: string }).dir === "/Users/me"
          ? {
              displayDir: "~",
              projectFolder: false,
              overleaf: false,
              remoteUrl: null,
              isPaper: false,
              inside: [{ dir: "/Users/me/proj", relPath: "proj", overleaf: false }],
              stoppedEarly: false,
            }
          : {
              displayDir: ".",
              projectFolder: true,
              overleaf: false,
              remoteUrl: null,
              isPaper: true,
              inside: [],
              stoppedEarly: false,
            },
      "paper.link": link,
    })
    fireEvent.click(await screen.findByTestId("edit-project-paper-choose"))
    const notPaper = await screen.findByTestId("paper-not-paper-dialog")
    expect(screen.getByTestId("edit-project-paper-folder").textContent).toBe("None")
    fireEvent.click(within(notPaper).getByTestId("paper-inside-option"))
    const root = await screen.findByTestId("paper-root-dialog")
    fireEvent.click(within(root).getByTestId("paper-root-no-sync"))
    await waitFor(() =>
      expect(screen.getByTestId("edit-project-paper-folder").textContent).toBe("Project folder"),
    )
    await waitFor(() =>
      expect((screen.getByTestId("edit-project-save") as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId("edit-project-save"))
    await waitFor(() =>
      expect(link).toHaveBeenCalledWith({
        projectId: "pf",
        dir: "/Users/me/proj",
        rootChoice: "no-sync",
      }),
    )
  })

  test("Clear forgets the folder when the dialog is saved; Cancel changes nothing", async () => {
    const unlink = vi.fn(() => ({ ok: true }))
    renderDetailsWith(project({ id: "pf", name: "P" }), "edit", null, {
      "paper.get": paperGet("paper"),
      "paper.unlink": unlink,
    })
    fireEvent.click(await screen.findByTestId("edit-project-paper-clear"))
    expect(screen.getByTestId("edit-project-paper-folder").textContent).toBe("None")
    fireEvent.click(screen.getByTestId("edit-project-cancel"))
    expect(unlink).not.toHaveBeenCalled()
    cleanup()

    const { onSave } = renderDetailsWith(project({ id: "pf", name: "P" }), "edit", null, {
      "paper.get": paperGet("paper"),
      "paper.unlink": unlink,
    })
    fireEvent.click(await screen.findByTestId("edit-project-paper-clear"))
    await waitFor(() =>
      expect((screen.getByTestId("edit-project-save") as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId("edit-project-save"))
    await waitFor(() => expect(unlink).toHaveBeenCalledWith({ projectId: "pf" }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
  })

  test("a failed paper folder change is shown and the other details are not saved", async () => {
    const { onSave } = renderDetailsWith(project({ id: "pf", name: "P" }), "edit", null, {
      "paper.get": paperGet("paper"),
      "paper.unlink": () => {
        throw new Error("could not clear")
      },
    })
    fireEvent.click(await screen.findByTestId("edit-project-paper-clear"))
    await waitFor(() =>
      expect((screen.getByTestId("edit-project-save") as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId("edit-project-save"))
    expect((await screen.findByRole("alert")).textContent).toContain("could not clear")
    expect(onSave).not.toHaveBeenCalled()
  })
})
