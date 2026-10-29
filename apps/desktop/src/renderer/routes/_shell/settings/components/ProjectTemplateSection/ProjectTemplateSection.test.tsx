import type { EditorSettings } from "@pi-lab/local-db/editor-settings"
import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"

/**
 * Component test for the Settings "Project template" editor. The real CodeMirror
 * view needs layout APIs jsdom lacks, so it is stubbed (re-exposing
 * `onChange`/`onSave` + the seeded `initialDoc`); the file list, selection, and
 * save round-trip are asserted through the DOM + a faked tRPC client,
 * mirroring the CentralPanel editor test.
 */

vi.mock("../../../../../Editor/components/CodeMirrorBuffer", () => ({
  CodeMirrorBuffer: ({
    relPath,
    initialDoc,
    onChange,
    onSave,
  }: {
    relPath: string
    initialDoc: string
    onChange: (doc: string) => void
    onSave: () => void
  }) => {
    const [seeded] = useState(initialDoc)
    return (
      <div data-testid="editor-buffer">
        <pre data-testid="buffer-doc">{seeded}</pre>
        <span data-testid="buffer-path">{relPath}</span>
        <button type="button" data-testid="buffer-type" onClick={() => onChange(`${seeded} EDIT`)}>
          type
        </button>
        <button type="button" data-testid="buffer-save" onClick={() => onSave()}>
          save
        </button>
      </div>
    )
  },
}))

const { ProjectTemplateSection } = await import("./ProjectTemplateSection")

const DEFAULT_SETTINGS: EditorSettings = {
  autosave: false,
  vim: false,
  diagnosticsEnabled: false,
  typeChecker: "ty",
  formatOnSave: false,
  editorTheme: "default",
  customEditorThemes: [],
  pythonRunDestination: "central",
  latexProvider: "bundled",
  showHiddenFiles: true,
  confirmFileDelete: true,
}

let store: Record<string, string>
let written: Array<{ relPath: string; content: string }>
let templateDefaultWrites: Array<{ initializationMarkdownFiles?: string[] }>
let imported: string[]
let removed: string[]

beforeEach(() => {
  store = { "AGENTS.md": "agents body", "RESEARCH.md": "research body" }
  written = []
  templateDefaultWrites = []
  imported = []
  removed = []
})

function baseHandlers(overrides: FakeHandlers = {}): FakeHandlers {
  return {
    "settings.get": () => ({
      editor: DEFAULT_SETTINGS,
      projectTemplate: {
        initializationMarkdownFiles: ["AGENTS.md", "RESEARCH.md"],
        defaultTemplateParentPath: null,
        projectTypes: [
          { id: "research", name: "Research project", guidance: "Research default" },
          { id: "software", name: "Software project", guidance: "Software default" },
          { id: "manuscript", name: "Manuscript", guidance: "Manuscript default" },
        ],
      },
    }),
    "template.list": () => [
      { name: ".gitignore", relPath: ".gitignore", kind: "file" as const },
      { name: "AGENTS.md", relPath: "AGENTS.md", kind: "file" as const },
      { name: "RESEARCH.md", relPath: "RESEARCH.md", kind: "file" as const },
    ],
    "template.read": (input) => {
      const { relPath } = input as { relPath: string }
      const content = store[relPath]
      return content === undefined ? { exists: false, content: "" } : { exists: true, content }
    },
    "template.write": (input) => {
      const { relPath, content } = input as { relPath: string; content: string }
      written.push({ relPath, content })
      store[relPath] = content
      return { bytes: content.length }
    },
    "template.import": (input) => {
      const { sourcePath } = input as { sourcePath: string }
      imported.push(sourcePath)
      return { name: "IMPORTED.md", relPath: "IMPORTED.md", kind: "file" as const }
    },
    "template.remove": (input) => {
      const { relPath } = input as { relPath: string }
      removed.push(relPath)
      return { relPath }
    },
    "system.pickFile": () => "/tmp/imported.md",
    "settings.updateProjectTemplate": (input) => {
      templateDefaultWrites.push(input as { initializationMarkdownFiles?: string[] })
      return input
    },
    ...overrides,
  }
}

function renderSection(handlers: FakeHandlers = baseHandlers()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(handlers)
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <ProjectTemplateSection />
    </AppProviders>,
  )
}

describe("ProjectTemplateSection", () => {
  test("edits built-in project-type guidance in Settings", async () => {
    const saved: Array<{ id: string; guidance: string }> = []
    renderSection(
      baseHandlers({
        "settings.updateProjectTypeGuidance": (input) => {
          const guidance = input as { id: string; guidance: string }
          saved.push(guidance)
          return guidance
        },
      }),
    )

    fireEvent.change(await screen.findByLabelText("Research project guidance"), {
      target: { value: "Describe experiments and results." },
    })
    fireEvent.click(
      screen.getByTestId("project-type-research").querySelector("button") as HTMLElement,
    )

    await waitFor(() =>
      expect(saved).toEqual([{ id: "research", guidance: "Describe experiments and results." }]),
    )
    expect(screen.queryByLabelText("New project type")).toBeNull()
  })

  test("lists template files and loads a selected file's content", async () => {
    renderSection()
    await screen.findByTestId("template-file-AGENTS.md")
    expect(screen.getByTestId("template-file-RESEARCH.md")).toBeTruthy()

    fireEvent.click(screen.getByTestId("template-file-AGENTS.md"))

    await waitFor(() => expect(screen.getByTestId("buffer-doc").textContent).toBe("agents body"))
    expect(screen.getByTestId("buffer-path").textContent).toBe("AGENTS.md")
  })

  test("selecting another file loads its content", async () => {
    renderSection()
    fireEvent.click(await screen.findByTestId("template-file-RESEARCH.md"))

    await waitFor(() => expect(screen.getByTestId("buffer-doc").textContent).toBe("research body"))
    expect(screen.getByTestId("buffer-path").textContent).toBe("RESEARCH.md")
  })

  test("editing then saving writes through template.write and clears the dirty state", async () => {
    renderSection()
    fireEvent.click(await screen.findByTestId("template-file-AGENTS.md"))
    await waitFor(() => expect(screen.getByTestId("buffer-doc").textContent).toBe("agents body"))

    // Clean ⇒ Save disabled.
    expect(screen.getByTestId("template-save").getAttribute("disabled")).not.toBeNull()

    fireEvent.click(screen.getByTestId("buffer-type"))
    await waitFor(() =>
      expect(screen.getByTestId("template-save").getAttribute("disabled")).toBeNull(),
    )

    fireEvent.click(screen.getByTestId("template-save"))
    await waitFor(() => expect(written).toHaveLength(1))
    expect(written[0]).toEqual({ relPath: "AGENTS.md", content: "agents body EDIT" })

    // Post-save refetch shows the saved content and the Save button re-disables.
    await waitFor(() =>
      expect(screen.getByTestId("buffer-doc").textContent).toBe("agents body EDIT"),
    )
    await waitFor(() =>
      expect(screen.getByTestId("template-save").getAttribute("disabled")).not.toBeNull(),
    )
  })

  test("persists the Markdown files included by default", async () => {
    renderSection()
    const agents = await screen.findByTestId("template-default-AGENTS.md")
    expect(agents.getAttribute("aria-pressed")).toBe("true")

    fireEvent.click(agents)

    await waitFor(() =>
      expect(templateDefaultWrites).toContainEqual({
        initializationMarkdownFiles: ["RESEARCH.md"],
      }),
    )
  })

  test("allows every template file to be selected by default", async () => {
    renderSection()
    const gitignore = await screen.findByTestId("template-default-.gitignore")
    expect(gitignore.getAttribute("disabled")).toBeNull()
    expect(gitignore.textContent).toBe(".gitignore")
    fireEvent.click(gitignore)
    await waitFor(() =>
      expect(templateDefaultWrites).toContainEqual({
        initializationMarkdownFiles: ["AGENTS.md", "RESEARCH.md", ".gitignore"],
      }),
    )
  })

  test("imports a template file through the native picker", async () => {
    renderSection()
    fireEvent.click(await screen.findByTestId("template-import-file"))
    await waitFor(() => expect(imported).toEqual(["/tmp/imported.md"]))
  })

  test("offers Remove when right-clicking a template file", async () => {
    renderSection()
    fireEvent.contextMenu(await screen.findByTestId("template-file-RESEARCH.md"), {
      clientX: 24,
      clientY: 32,
    })
    expect(await screen.findByTestId("template-file-context-menu")).toBeTruthy()
    fireEvent.click(screen.getByTestId("template-file-remove"))
    await waitFor(() => expect(removed).toEqual(["RESEARCH.md"]))
    await waitFor(() =>
      expect(templateDefaultWrites).toContainEqual({ initializationMarkdownFiles: ["AGENTS.md"] }),
    )
  })
})
