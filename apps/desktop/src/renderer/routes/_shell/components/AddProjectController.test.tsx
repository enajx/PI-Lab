import type { Project } from "@pi-lab/local-db"
import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { setInterfaceLanguage } from "../../../i18n/language"
import { AppProviders } from "../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../test/fakeTrpcClient"
import { AddProjectControllerProvider, useAddProjectController } from "./AddProjectController"

const project: Project = {
  id: "project-added",
  metadata: null,
  taskRelPath: null,
  mainRelPath: null,
  typeId: "general",
  agentConfig: null,
  repoPath: "/tmp/project-added",
  name: "Project Added",
  defaultBranch: "main",
  color: null,
  thumbnail: null,
  gradient: null,
  digitalRain: false,
  sortIndex: 0,
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
  lastOpenedAt: 0,
}

function ControllerHarness({ onAdded }: { onAdded: (added: Project) => void }) {
  const { openAddProject } = useAddProjectController()
  return (
    <button type="button" onClick={() => openAddProject({ onAdded })}>
      Open controlled chooser
    </button>
  )
}

function renderController(onAdded: (added: Project) => void, handlers: FakeHandlers) {
  const client = createFakeTrpcClient(handlers)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <AddProjectControllerProvider>
        <ControllerHarness onAdded={onAdded} />
      </AddProjectControllerProvider>
    </AppProviders>,
  )
}

describe("AddProjectControllerProvider", () => {
  test("shows the project chooser in the selected language", () => {
    setInterfaceLanguage("es")
    renderController(vi.fn(), {})
    fireEvent.click(screen.getByRole("button", { name: "Open controlled chooser" }))
    expect(screen.getByTestId("add-project-folder").textContent).toContain("Abrir desde carpeta")
    setInterfaceLanguage("en")
  })

  test("opens the shared chooser and picker cancellation is a no-op", async () => {
    const onAdded = vi.fn()
    const openProject = vi.fn()
    renderController(onAdded, {
      "system.pickDirectory": () => null,
      "projects.open": openProject,
    })

    expect(screen.queryByTestId("add-project-menu")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Open controlled chooser" }))

    expect(screen.getByTestId("add-project-menu")).toBeTruthy()
    expect(screen.getByTestId("add-project-folder")).toBeTruthy()
    expect(screen.getByTestId("add-project-clone")).toBeTruthy()
    expect(screen.getByTestId("add-project-template")).toBeTruthy()

    fireEvent.click(screen.getByTestId("add-project-folder"))
    await waitFor(() => expect(openProject).not.toHaveBeenCalled())
    expect(onAdded).not.toHaveBeenCalled()
    expect(screen.getByTestId("add-project-menu")).toBeTruthy()

    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByTestId("add-project-menu")).toBeNull()
    expect(onAdded).not.toHaveBeenCalled()
  })

  test("cycles the global chooser with arrows and confirms the selected option with Enter", async () => {
    const onAdded = vi.fn()
    renderController(onAdded, {
      "system.pickDirectory": () => null,
      "projects.open": vi.fn(),
    })

    fireEvent.click(screen.getByRole("button", { name: "Open controlled chooser" }))
    expect(screen.getByTestId("add-project-folder").className).toContain("bg-accent")
    fireEvent.keyDown(window, { key: "ArrowDown" })
    expect(screen.getByTestId("add-project-clone").className).toContain("bg-accent")
    fireEvent.keyDown(window, { key: "Enter" })
    expect(screen.getByTestId("add-project-clone-form")).toBeTruthy()
  })

  test("collects details before registration and preserves the form for retry", async () => {
    const onAdded = vi.fn()
    const openProject = vi
      .fn()
      .mockRejectedValueOnce(new Error("Could not add that folder"))
      .mockResolvedValue(project)
    renderController(onAdded, {
      "system.pickDirectory": () => "/tmp/project-added",
      "projects.open": openProject,
      "agents.list": () => [],
    })
    fireEvent.click(screen.getByRole("button", { name: "Open controlled chooser" }))
    fireEvent.click(screen.getByTestId("add-project-folder"))
    const name = await screen.findByTestId("edit-project-name")
    expect((name as HTMLInputElement).value).toBe("project-added")
    expect(openProject).not.toHaveBeenCalled()
    fireEvent.change(name, { target: { value: "My software" } })
    fireEvent.click(screen.getByRole("button", { name: /^Add project$/ }))
    expect(await screen.findByText("Could not add that folder")).toBeTruthy()
    expect(onAdded).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: /^Add project$/ }))
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(project))
    expect(openProject).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: "/tmp/project-added",
        details: expect.objectContaining({
          name: "My software",
          typeId: "general",
          agentId: null,
        }),
      }),
    )
    expect(screen.queryByTestId("add-project-dialog")).toBeNull()
  })

  test("Cancel leaves a folder unregistered and Plan research is a disabled placeholder", async () => {
    const onAdded = vi.fn()
    const openProject = vi.fn()
    renderController(onAdded, {
      "system.pickDirectory": () => "/tmp/project-added",
      "projects.open": openProject,
      "agents.list": () => [],
    })
    fireEvent.click(screen.getByRole("button", { name: "Open controlled chooser" }))
    fireEvent.click(screen.getByTestId("add-project-folder"))
    await screen.findByTestId("edit-project-name")
    expect(
      (screen.getByRole("button", { name: "Plan research" }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.queryByText("Plan this project?")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(openProject).not.toHaveBeenCalled()
    expect(onAdded).not.toHaveBeenCalled()
    expect(screen.queryByTestId("add-project-dialog")).toBeNull()
  })
})
