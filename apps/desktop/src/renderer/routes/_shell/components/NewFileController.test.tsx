import { QueryClient } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { setInterfaceLanguage } from "../../../i18n/language"
import { AppProviders } from "../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../test/fakeTrpcClient"
import { NewFileControllerProvider, useNewFileController } from "./NewFileController"

const projects = [
  {
    id: "alpha",
    name: "Alpha",
    repoPath: "/tmp/alpha",
    archivedAt: null,
  },
  {
    id: "hidden",
    name: "Hidden",
    repoPath: "/tmp/hidden",
    archivedAt: 123,
  },
]

function ControllerHarness({
  onCreated,
  initialProjectId,
}: {
  onCreated: (created: { projectId: string; relPath: string }) => void
  initialProjectId?: string
}) {
  const { openNewFile } = useNewFileController()
  return (
    <button type="button" onClick={() => openNewFile({ onCreated, initialProjectId })}>
      Open new file flow
    </button>
  )
}

function renderController(
  onCreated: (created: { projectId: string; relPath: string }) => void,
  handlers: FakeHandlers,
  initialProjectId?: string,
) {
  const client = createFakeTrpcClient(handlers)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <NewFileControllerProvider>
        <ControllerHarness onCreated={onCreated} initialProjectId={initialProjectId} />
      </NewFileControllerProvider>
    </AppProviders>,
  )
}

describe("NewFileControllerProvider", () => {
  test("changes file creation labels with the selected language", async () => {
    renderController(vi.fn(), {
      "projects.list": () => projects,
      "workspaces.ensureMain": () => ({ id: "unused" }),
      "files.createFile": () => ({ relPath: "unused" }),
    })
    fireEvent.click(screen.getByRole("button", { name: "Open new file flow" }))
    act(() => setInterfaceLanguage("es"))
    expect(await screen.findByRole("dialog", { name: "Archivo nuevo" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Crear y abrir" })).toBeTruthy()
    act(() => setInterfaceLanguage("en"))
  })

  test("translates a known file creation validation error", async () => {
    renderController(vi.fn(), {
      "projects.list": () => projects,
      "workspaces.ensureMain": () => ({ id: "workspace-alpha" }),
      "files.createFile": () => {
        throw new Error("A file or folder already exists at notes/idea.md")
      },
    })
    fireEvent.click(screen.getByRole("button", { name: "Open new file flow" }))
    act(() => setInterfaceLanguage("es"))
    fireEvent.change(await screen.findByLabelText("Proyecto"), { target: { value: "alpha" } })
    fireEvent.change(screen.getByLabelText("Nombre del archivo"), {
      target: { value: "notes/idea.md" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Crear y abrir" }))
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Ya existe un archivo o carpeta en notes/idea.md",
    )
    act(() => setInterfaceLanguage("en"))
  })
  test("asks for a project and file name, creates there, and reports the file", async () => {
    const onCreated = vi.fn()
    const ensureMain = vi.fn(() => ({ id: "workspace-alpha" }))
    const createFile = vi.fn((input: unknown) => {
      const { relPath } = input as { relPath: string }
      return { relPath }
    })
    renderController(onCreated, {
      "projects.list": () => projects,
      "workspaces.ensureMain": ensureMain,
      "files.createFile": createFile,
    })

    fireEvent.click(screen.getByRole("button", { name: "Open new file flow" }))
    const dialog = await screen.findByRole("dialog", { name: "New file" })
    expect(dialog).toBeTruthy()
    expect(await screen.findByRole("option", { name: "Alpha — /tmp/alpha" })).toBeTruthy()
    expect(screen.getByRole("option", { name: "Hidden (hidden) — /tmp/hidden" })).toBeTruthy()

    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "alpha" } })
    fireEvent.change(screen.getByLabelText("File name"), {
      target: { value: " notes/idea.md " },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create and open" }))

    await waitFor(() => {
      expect(ensureMain).toHaveBeenCalledWith({ projectId: "alpha" })
      expect(createFile).toHaveBeenCalledWith({
        workspaceId: "workspace-alpha",
        relPath: "notes/idea.md",
      })
      expect(onCreated).toHaveBeenCalledWith({
        projectId: "alpha",
        relPath: "notes/idea.md",
      })
    })
    expect(screen.queryByRole("dialog", { name: "New file" })).toBeNull()
  })

  test("preselects the project that was active when Save was requested", async () => {
    renderController(
      vi.fn(),
      {
        "projects.list": () => projects,
        "workspaces.ensureMain": () => ({ id: "unused" }),
        "files.createFile": () => ({ relPath: "unused" }),
      },
      "alpha",
    )

    fireEvent.click(screen.getByRole("button", { name: "Open new file flow" }))
    expect(((await screen.findByLabelText("Project")) as HTMLSelectElement).value).toBe("alpha")
  })

  test("keeps creation errors visible and can be cancelled without creating", async () => {
    const onCreated = vi.fn()
    const createFile = vi.fn(() => {
      throw new Error("File already exists")
    })
    renderController(onCreated, {
      "projects.list": () => projects,
      "workspaces.ensureMain": () => ({ id: "workspace-alpha" }),
      "files.createFile": createFile,
    })

    fireEvent.click(screen.getByRole("button", { name: "Open new file flow" }))
    await screen.findByRole("option", { name: "Alpha — /tmp/alpha" })
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "alpha" } })
    fireEvent.change(screen.getByLabelText("File name"), {
      target: { value: "notes/idea.md" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create and open" }))

    expect((await screen.findByRole("alert")).textContent).toContain("File already exists")
    expect(onCreated).not.toHaveBeenCalled()
    expect(screen.getByRole("dialog", { name: "New file" })).toBeTruthy()

    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByRole("dialog", { name: "New file" })).toBeNull()
    expect(onCreated).not.toHaveBeenCalled()
  })

  test("explains that a project is required when none exist", async () => {
    const onCreated = vi.fn()
    renderController(onCreated, {
      "projects.list": () => [],
      "workspaces.ensureMain": () => ({ id: "unused" }),
      "files.createFile": () => ({ relPath: "unused" }),
    })

    fireEvent.click(screen.getByRole("button", { name: "Open new file flow" }))
    expect(await screen.findByText("Add a project before creating a file.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Create and open" }).hasAttribute("disabled")).toBe(
      true,
    )
  })

  test("surfaces a project-list failure instead of showing an inert empty chooser", async () => {
    renderController(vi.fn(), {
      "projects.list": () => {
        throw new Error("Could not load projects")
      },
      "workspaces.ensureMain": () => ({ id: "unused" }),
      "files.createFile": () => ({ relPath: "unused" }),
    })

    fireEvent.click(screen.getByRole("button", { name: "Open new file flow" }))
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load projects")
    expect(screen.getByRole("button", { name: "Create and open" }).hasAttribute("disabled")).toBe(
      true,
    )
  })
})
