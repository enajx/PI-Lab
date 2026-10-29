import { QueryClient } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../test/fakeTrpcClient"
import { FileTree } from "./FileTree"

interface Entry {
  name: string
  relPath: string
  kind: "file" | "dir"
  type: string
  mtimeMs: number
}

function renderTree(handlers: FakeHandlers, onOpenFile = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(handlers)
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <FileTree workspaceId="ws-1" onOpenFile={onOpenFile} />
    </AppProviders>,
  )
  return { onOpenFile }
}

describe("FileTree creation and sorting", () => {
  beforeEach(() => window.localStorage.clear())

  test("translates file controls while preserving file names", async () => {
    window.localStorage.setItem("pi-lab.interface.language", "es")
    renderTree({
      "files.tree": () => [
        { name: "notes.md", relPath: "notes.md", kind: "file", type: "md", mtimeMs: 1 },
      ],
    })

    expect(await screen.findByRole("button", { name: "Archivo nuevo" })).toBeTruthy()
    expect(screen.getByTestId("file-tree-root").textContent).toBe("Archivos")
    expect((await screen.findByTestId("file-tree-file")).textContent).toBe("notes.md")
  })

  test("creates inline in the selected folder, refreshes, and opens a new file", async () => {
    const entries = new Map<string, Entry[]>([
      ["", [{ name: "src", relPath: "src", kind: "dir", type: "folder", mtimeMs: 10 }]],
      ["src", []],
    ])
    const createCalls: unknown[] = []
    const { onOpenFile } = renderTree({
      "files.tree": (input) => entries.get((input as { relPath: string }).relPath) ?? [],
      "files.createFile": (input) => {
        createCalls.push(input)
        entries.set("src", [
          { name: "notes.md", relPath: "src/notes.md", kind: "file", type: "md", mtimeMs: 20 },
        ])
        return { relPath: "src/notes.md" }
      },
      "files.createFolder": () => ({ relPath: "unused" }),
    })

    fireEvent.click(await screen.findByTestId("file-tree-dir"))
    expect(screen.getByTestId("file-tree-dir").getAttribute("data-selected")).toBe("true")
    fireEvent.click(screen.getByRole("button", { name: "New file" }))
    const input = screen.getByRole("textbox", { name: "New file name" })
    fireEvent.change(input, { target: { value: "notes.md" } })
    fireEvent.keyDown(input, { key: "Enter" })

    await waitFor(() =>
      expect(createCalls).toEqual([{ workspaceId: "ws-1", relPath: "src/notes.md" }]),
    )
    await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith("src/notes.md"))
    expect(await screen.findByText("notes.md")).toBeTruthy()
  })

  test("keeps directories first and supports every remembered sort", async () => {
    const rootEntries: Entry[] = [
      { name: "zeta.txt", relPath: "zeta.txt", kind: "file", type: "txt", mtimeMs: 20 },
      { name: "folder", relPath: "folder", kind: "dir", type: "folder", mtimeMs: 5 },
      { name: "alpha.py", relPath: "alpha.py", kind: "file", type: "py", mtimeMs: 30 },
      { name: "beta.md", relPath: "beta.md", kind: "file", type: "md", mtimeMs: 10 },
    ]
    renderTree({
      "files.tree": () => rootEntries,
      "files.createFile": () => ({ relPath: "unused" }),
      "files.createFolder": () => ({ relPath: "unused" }),
    })

    const sort = await screen.findByRole("button", { name: "File sort: Name A–Z" })
    const fileNames = () => screen.getAllByTestId("file-tree-file").map((row) => row.textContent)
    const root = await screen.findByTestId("file-tree-level:root")

    expect(root.firstElementChild?.querySelector('[data-testid="file-tree-dir"]')).toBeTruthy()
    expect(fileNames()).toEqual(["alpha.py", "beta.md", "zeta.txt"])

    fireEvent.click(sort)
    expect(sort.getAttribute("aria-label")).toBe("File sort: Name Z–A")
    expect(fileNames()).toEqual(["zeta.txt", "beta.md", "alpha.py"])

    fireEvent.click(sort)
    expect(sort.getAttribute("aria-label")).toBe("File sort: Type")
    expect(fileNames()).toEqual(["beta.md", "alpha.py", "zeta.txt"])

    fireEvent.click(sort)
    expect(sort.getAttribute("aria-label")).toBe("File sort: Modified date")
    expect(fileNames()).toEqual(["alpha.py", "zeta.txt", "beta.md"])
    expect(window.localStorage.getItem("pi-lab.fileTree.sort")).toBe("modified")
  })

  test("keeps duplicate and invalid-name failures visible inline", async () => {
    renderTree({
      "files.tree": () => [],
      "files.createFile": () => {
        throw new Error("A file already exists at duplicate.md")
      },
      "files.createFolder": () => ({ relPath: "unused" }),
    })

    fireEvent.click(await screen.findByRole("button", { name: "New file" }))
    const input = screen.getByRole("textbox", { name: "New file name" })
    fireEvent.change(input, { target: { value: "../duplicate.md" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect((await screen.findByTestId("file-tree-create-error")).textContent).toContain(
      "Names cannot contain path separators",
    )

    fireEvent.change(input, { target: { value: "duplicate.md" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(screen.getByTestId("file-tree-create-error").textContent).toContain("already exists"),
    )
    expect(within(screen.getByTestId("file-tree-create-row")).getByRole("textbox")).toBeTruthy()
  })
})

interface ManagedTreeOptions {
  handlers: FakeHandlers
  tabs: { relPath: string; dirty: boolean }[]
}

/** Render the tree with editor tabs, recording tab closes and opened files. */
function renderManagedTree({ handlers, tabs }: ManagedTreeOptions) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(handlers)
  const onOpenFile = vi.fn()
  const closeFile = vi.fn()
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <FileTree workspaceId="ws-1" onOpenFile={onOpenFile} editorTabs={{ tabs, closeFile }} />
    </AppProviders>,
  )
  return { onOpenFile, closeFile }
}

/** A small workspace: `src/` holding `main.py`, plus `notes.md` and `.env` at the root. */
function workspaceEntries(): Map<string, Entry[]> {
  return new Map<string, Entry[]>([
    [
      "",
      [
        { name: "src", relPath: "src", kind: "dir", type: "folder", mtimeMs: 1 },
        { name: ".env", relPath: ".env", kind: "file", type: "file", mtimeMs: 1 },
        { name: "notes.md", relPath: "notes.md", kind: "file", type: "md", mtimeMs: 1 },
      ],
    ],
    ["src", [{ name: "main.py", relPath: "src/main.py", kind: "file", type: "py", mtimeMs: 1 }]],
  ])
}

function treeHandlers(entries: Map<string, Entry[]>, extra: FakeHandlers): FakeHandlers {
  return {
    "files.tree": (input) => entries.get((input as { relPath: string }).relPath) ?? [],
    "files.createFile": () => ({ relPath: "unused" }),
    "files.createFolder": () => ({ relPath: "unused" }),
    ...extra,
  }
}

const fileRow = (name: string) =>
  screen.getAllByTestId("file-tree-file").find((row) => row.textContent === name) as HTMLElement

const menuItems = () =>
  within(screen.getByTestId("file-tree-context-menu"))
    .getAllByRole("menuitem")
    .map((item) => item.textContent)

describe("FileTree file and folder management", () => {
  beforeEach(() => window.localStorage.clear())

  test("right-click offers the agreed file and folder actions", async () => {
    renderManagedTree({ handlers: treeHandlers(workspaceEntries(), {}), tabs: [] })

    fireEvent.contextMenu(await screen.findByText("notes.md"))
    expect(menuItems()).toEqual([
      "Open",
      "Reveal in Finder",
      "Copy Path",
      "Copy Relative Path",
      "Rename",
      "Duplicate",
      "Delete",
    ])
    fireEvent.keyDown(window, { key: "Escape" })

    fireEvent.contextMenu(screen.getByTestId("file-tree-dir"))
    expect(menuItems()).toEqual([
      "New File",
      "New Folder",
      "Reveal in Finder",
      "Copy Path",
      "Copy Relative Path",
      "Rename",
      "Delete",
    ])
  })

  test("Open, Reveal, Copy Path, and Duplicate act on the right-clicked file", async () => {
    const calls: [string, unknown][] = []
    const record = (path: string) => (input: unknown) => {
      calls.push([path, input])
      return path === "files.duplicate" ? { relPath: "notes copy.md" } : null
    }
    const { onOpenFile } = renderManagedTree({
      handlers: treeHandlers(workspaceEntries(), {
        "files.reveal": record("files.reveal"),
        "files.copyPath": record("files.copyPath"),
        "files.duplicate": record("files.duplicate"),
      }),
      tabs: [],
    })
    const choose = async (label: string) => {
      fireEvent.contextMenu(await screen.findByText("notes.md"))
      fireEvent.click(screen.getByRole("menuitem", { name: label }))
    }

    await choose("Open")
    expect(onOpenFile).toHaveBeenCalledWith("notes.md")
    await choose("Reveal in Finder")
    await choose("Copy Path")
    await choose("Copy Relative Path")
    await choose("Duplicate")
    await waitFor(() => expect(calls).toHaveLength(4))
    expect(calls).toEqual([
      ["files.reveal", { workspaceId: "ws-1", relPath: "notes.md" }],
      ["files.copyPath", { workspaceId: "ws-1", relPath: "notes.md", form: "absolute" }],
      ["files.copyPath", { workspaceId: "ws-1", relPath: "notes.md", form: "relative" }],
      ["files.duplicate", { workspaceId: "ws-1", relPath: "notes.md" }],
    ])
  })

  test("Delete confirms by name, warns about unsaved tabs, trashes, and closes the tab", async () => {
    const entries = workspaceEntries()
    const trashed: unknown[] = []
    const { closeFile } = renderManagedTree({
      handlers: treeHandlers(entries, {
        "files.trash": (input) => {
          trashed.push(input)
          entries.set(
            "",
            (entries.get("") ?? []).filter((entry) => entry.relPath !== "notes.md"),
          )
          return null
        },
      }),
      tabs: [{ relPath: "notes.md", dirty: true }],
    })

    fireEvent.contextMenu(await screen.findByText("notes.md"))
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }))
    const dialog = screen.getByRole("alertdialog")
    expect(dialog.textContent).toContain("notes.md")
    expect(dialog.textContent).toContain("unsaved changes")

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(trashed).toEqual([])

    fireEvent.contextMenu(screen.getByText("notes.md"))
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }))
    fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }))

    await waitFor(() => expect(trashed).toEqual([{ workspaceId: "ws-1", relPath: "notes.md" }]))
    await waitFor(() => expect(closeFile).toHaveBeenCalledWith("notes.md"))
    await waitFor(() => expect(screen.queryByText("notes.md")).toBeNull())
  })

  test("a failed delete stays visible and keeps the tab open", async () => {
    const { closeFile } = renderManagedTree({
      handlers: treeHandlers(workspaceEntries(), {
        "files.trash": () => {
          throw new Error("Could not move notes.md to the Trash")
        },
      }),
      tabs: [{ relPath: "notes.md", dirty: false }],
    })

    fireEvent.contextMenu(await screen.findByText("notes.md"))
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }))
    fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }))

    expect((await screen.findByRole("alert")).textContent).toContain("Could not move notes.md")
    expect(closeFile).not.toHaveBeenCalled()
  })

  test("Cmd+Backspace on a focused folder deletes it and closes the tabs inside it", async () => {
    const trashed: unknown[] = []
    const { closeFile } = renderManagedTree({
      handlers: treeHandlers(workspaceEntries(), {
        "files.trash": (input) => {
          trashed.push(input)
          return null
        },
      }),
      tabs: [
        { relPath: "src/main.py", dirty: false },
        { relPath: "notes.md", dirty: false },
      ],
    })

    const folder = await screen.findByTestId("file-tree-dir")
    folder.focus()
    fireEvent.keyDown(folder, { key: "Backspace", metaKey: true })
    const dialog = screen.getByRole("alertdialog")
    expect(dialog.textContent).toContain("src")
    expect(dialog.textContent).not.toContain("unsaved changes")
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to Trash" }))

    await waitFor(() => expect(trashed).toEqual([{ workspaceId: "ws-1", relPath: "src" }]))
    await waitFor(() => expect(closeFile).toHaveBeenCalledWith("src/main.py"))
    expect(closeFile).not.toHaveBeenCalledWith("notes.md")
  })

  test("Cmd+Backspace on a focused file asks to delete it, but never from the rename input", async () => {
    renderManagedTree({ handlers: treeHandlers(workspaceEntries(), {}), tabs: [] })

    const row = await screen.findByText("notes.md")
    fireEvent.keyDown(fileRow("notes.md"), { key: "Backspace", metaKey: true })
    expect(screen.getByRole("alertdialog").textContent).toContain("notes.md")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }))
    const input = screen.getByRole("textbox", { name: "Rename notes.md" })
    fireEvent.keyDown(input, { key: "Backspace", metaKey: true })
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  test("Rename edits the name inline and reopens a clean open tab at the new path", async () => {
    const renames: unknown[] = []
    const { onOpenFile, closeFile } = renderManagedTree({
      handlers: treeHandlers(workspaceEntries(), {
        "files.rename": (input) => {
          renames.push(input)
          return { relPath: "ideas.md" }
        },
      }),
      tabs: [{ relPath: "notes.md", dirty: false }],
    })

    fireEvent.contextMenu(await screen.findByText("notes.md"))
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }))
    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Rename notes.md" })
    expect(input.value).toBe("notes.md")
    fireEvent.change(input, { target: { value: "ideas.md" } })
    fireEvent.keyDown(input, { key: "Enter" })

    await waitFor(() =>
      expect(renames).toEqual([
        { workspaceId: "ws-1", relPath: "notes.md", newRelPath: "ideas.md" },
      ]),
    )
    await waitFor(() => expect(closeFile).toHaveBeenCalledWith("notes.md"))
    expect(onOpenFile).toHaveBeenCalledWith("ideas.md")
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull())
  })

  test("Rename refuses while an affected tab has unsaved changes", async () => {
    const renames: unknown[] = []
    renderManagedTree({
      handlers: treeHandlers(workspaceEntries(), {
        "files.rename": (input) => {
          renames.push(input)
          return { relPath: "lib" }
        },
      }),
      tabs: [{ relPath: "src/main.py", dirty: true }],
    })

    fireEvent.contextMenu(await screen.findByTestId("file-tree-dir"))
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }))
    const input = screen.getByRole("textbox", { name: "Rename src" })
    fireEvent.change(input, { target: { value: "lib" } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect((await screen.findByTestId("file-tree-rename-error")).textContent).toContain(
      "src/main.py",
    )
    expect(renames).toEqual([])
  })

  test("New File from a folder's menu creates inside that folder", async () => {
    const created: unknown[] = []
    renderManagedTree({
      handlers: treeHandlers(workspaceEntries(), {
        "files.createFile": (input) => {
          created.push(input)
          return { relPath: "src/util.py" }
        },
      }),
      tabs: [],
    })

    fireEvent.contextMenu(await screen.findByTestId("file-tree-dir"))
    fireEvent.click(screen.getByRole("menuitem", { name: "New File" }))
    const input = screen.getByRole("textbox", { name: "New file name" })
    fireEvent.change(input, { target: { value: "util.py" } })
    fireEvent.keyDown(input, { key: "Enter" })

    await waitFor(() => expect(created).toEqual([{ workspaceId: "ws-1", relPath: "src/util.py" }]))
  })

  test("right-click selects the row without opening it and keeps it highlighted while the menu is open", async () => {
    const { onOpenFile } = renderManagedTree({
      handlers: treeHandlers(workspaceEntries(), {}),
      tabs: [],
    })

    fireEvent.contextMenu(await screen.findByText("notes.md"))
    const row = fileRow("notes.md")
    expect(onOpenFile).not.toHaveBeenCalled()
    expect(row.getAttribute("data-selected")).toBe("true")
    expect(row.getAttribute("data-menu-open")).toBe("true")
    expect(row.className).toContain("bg-accent")
    // Moving the pointer into the menu leaves the row's highlight in place.
    fireEvent.mouseLeave(row)
    fireEvent.mouseEnter(screen.getByTestId("file-tree-context-menu"))
    expect(row.getAttribute("data-menu-open")).toBe("true")

    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByTestId("file-tree-context-menu")).toBeNull()
    expect(row.getAttribute("data-menu-open")).toBeNull()
    expect(row.getAttribute("data-selected")).toBe("true")

    // A folder becomes the selected row too, without expanding.
    const folder = screen.getByTestId("file-tree-dir")
    fireEvent.contextMenu(folder)
    expect(folder.getAttribute("data-selected")).toBe("true")
    expect(folder.getAttribute("data-menu-open")).toBe("true")
    expect(fileRow("notes.md").getAttribute("data-selected")).toBe("false")
    expect(screen.queryByTestId("file-tree-level:src")).toBeNull()
  })

  test("Don't ask again saves confirmFileDelete off and later deletes skip the dialog", async () => {
    const entries = workspaceEntries()
    const trashed: unknown[] = []
    const patches: unknown[] = []
    let confirmFileDelete = true
    renderManagedTree({
      handlers: treeHandlers(entries, {
        // Dotfiles hide together with the saved choice, so the refetch is observable.
        "settings.get": () => ({
          editor: { confirmFileDelete, showHiddenFiles: confirmFileDelete },
        }),
        "settings.updateEditor": (input) => {
          patches.push(input)
          confirmFileDelete = (input as { confirmFileDelete: boolean }).confirmFileDelete
          return null
        },
        "files.trash": (input) => {
          trashed.push(input)
          return null
        },
      }),
      tabs: [],
    })

    await screen.findByText("notes.md")
    fireEvent.keyDown(fileRow("notes.md"), { key: "Backspace", metaKey: true })
    const dialog = screen.getByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Don't ask again" }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to Trash" }))

    await waitFor(() => expect(patches).toEqual([{ confirmFileDelete: false }]))
    await waitFor(() => expect(trashed).toEqual([{ workspaceId: "ws-1", relPath: "notes.md" }]))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    await waitFor(() => expect(screen.queryByText(".env")).toBeNull())

    // Both ⌘⌫ and the menu's Delete now trash straight away.
    fireEvent.keyDown(screen.getByTestId("file-tree-dir"), { key: "Backspace", metaKey: true })
    expect(screen.queryByRole("alertdialog")).toBeNull()
    fireEvent.contextMenu(fileRow("notes.md"))
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }))
    expect(screen.queryByRole("alertdialog")).toBeNull()
    await waitFor(() =>
      expect(trashed).toEqual([
        { workspaceId: "ws-1", relPath: "notes.md" },
        { workspaceId: "ws-1", relPath: "src" },
        { workspaceId: "ws-1", relPath: "notes.md" },
      ]),
    )
  })

  test("with confirmation off, unsaved tabs still ask without the checkbox and trash errors stay visible", async () => {
    const { closeFile } = renderManagedTree({
      handlers: treeHandlers(workspaceEntries(), {
        // Hiding dotfiles makes the loaded settings observable before deleting.
        "settings.get": () => ({ editor: { confirmFileDelete: false, showHiddenFiles: false } }),
        "files.trash": () => {
          throw new Error("Could not move src to the Trash")
        },
      }),
      tabs: [{ relPath: "notes.md", dirty: true }],
    })

    await screen.findByText("notes.md")
    await waitFor(() => expect(screen.queryByText(".env")).toBeNull())
    fireEvent.keyDown(screen.getByTestId("file-tree-dir"), { key: "Backspace", metaKey: true })
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect((await screen.findByTestId("file-tree-action-error")).textContent).toContain(
      "Could not move src",
    )

    fireEvent.keyDown(fileRow("notes.md"), { key: "Backspace", metaKey: true })
    const dialog = screen.getByRole("alertdialog")
    expect(dialog.textContent).toContain("unsaved changes")
    expect(within(dialog).queryByRole("checkbox")).toBeNull()
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    expect(closeFile).not.toHaveBeenCalled()
  })

  test("hidden files follow the editor setting and are shown by default", async () => {
    renderManagedTree({ handlers: treeHandlers(workspaceEntries(), {}), tabs: [] })
    expect(await screen.findByText(".env")).toBeTruthy()
    cleanup()

    renderManagedTree({
      handlers: treeHandlers(workspaceEntries(), {
        "settings.get": () => ({ editor: { showHiddenFiles: false } }),
      }),
      tabs: [],
    })
    expect(await screen.findByText("notes.md")).toBeTruthy()
    await waitFor(() => expect(screen.queryByText(".env")).toBeNull())
  })
})

/** Render the tree with an editor active file that the test can change, like switching tabs. */
function renderTreeWithActive(handlers: FakeHandlers, activeRelPath: string | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(handlers)
  const onOpenFile = vi.fn()
  const tree = (active: string | null) => (
    <AppProviders client={client} queryClient={queryClient}>
      <FileTree workspaceId="ws-1" onOpenFile={onOpenFile} activeRelPath={active} />
    </AppProviders>
  )
  const view = render(tree(activeRelPath))
  return { onOpenFile, setActive: (active: string | null) => view.rerender(tree(active)) }
}

/** The paths of every tree row that carries the selected highlight. */
const selectedRows = () =>
  [...screen.queryAllByTestId("file-tree-dir"), ...screen.queryAllByTestId("file-tree-file")]
    .filter((row) => row.getAttribute("data-selected") === "true")
    .map((row) => row.getAttribute("data-rel-path"))

/** True when the row has a persistent background shade (hover classes excluded). */
const shaded = (row: HTMLElement) =>
  row.className.split(" ").some((name) => name.startsWith("bg-accent"))

describe("FileTree single selection and focus", () => {
  beforeEach(() => window.localStorage.clear())

  test("exactly one row is selected across folder click, file click, right-click, and active-file changes", async () => {
    const { setActive } = renderTreeWithActive(treeHandlers(workspaceEntries(), {}), "notes.md")
    await screen.findByText("notes.md")
    expect(selectedRows()).toEqual(["notes.md"])

    fireEvent.click(screen.getByTestId("file-tree-dir"))
    expect(selectedRows()).toEqual(["src"])

    fireEvent.click(fileRow("notes.md"))
    expect(selectedRows()).toEqual(["notes.md"])

    // Right-click while another file is active: the right-clicked row is the only highlight.
    fireEvent.click(screen.getByTestId("file-tree-dir"))
    fireEvent.contextMenu(fileRow(".env"))
    expect(selectedRows()).toEqual([".env"])
    expect(shaded(fileRow(".env"))).toBe(true)
    expect(shaded(fileRow("notes.md"))).toBe(false)
    expect(shaded(screen.getByTestId("file-tree-dir"))).toBe(false)
    fireEvent.keyDown(window, { key: "Escape" })

    // Switching tabs in the editor moves the selection to the new active file.
    fireEvent.click(screen.getByTestId("file-tree-dir"))
    await screen.findByText("main.py")
    expect(selectedRows()).toEqual(["src"])
    setActive("src/main.py")
    expect(selectedRows()).toEqual(["src/main.py"])
    // The active file keeps its Eye marker even when another row is selected.
    fireEvent.contextMenu(fileRow("notes.md"))
    expect(selectedRows()).toEqual(["notes.md"])
    expect(within(fileRow("main.py")).getByTestId("file-tree-focused")).toBeTruthy()
  })

  test("keyboard focus moving to a row selects it", async () => {
    renderTreeWithActive(treeHandlers(workspaceEntries(), {}), "notes.md")
    await screen.findByText("notes.md")
    fireEvent.focus(screen.getByTestId("file-tree-dir"))
    expect(selectedRows()).toEqual(["src"])
  })

  test("New File targets the selected file's folder", async () => {
    const created: unknown[] = []
    renderTreeWithActive(
      treeHandlers(workspaceEntries(), {
        "files.createFile": (input) => {
          created.push(input)
          return { relPath: "src/util.py" }
        },
      }),
      null,
    )
    fireEvent.click(await screen.findByTestId("file-tree-dir"))
    fireEvent.click(screen.getByTestId("file-tree-root"))
    fireEvent.click(await screen.findByText("main.py"))
    fireEvent.click(screen.getByRole("button", { name: "New file" }))
    const input = screen.getByRole("textbox", { name: "New file name" })
    fireEvent.change(input, { target: { value: "util.py" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(created).toEqual([{ workspaceId: "ws-1", relPath: "src/util.py" }]))
  })

  test("a click on a file opens it, keeps keyboard focus on the row, and ⌘⌫ then asks to delete it", async () => {
    const { onOpenFile } = renderTreeWithActive(treeHandlers(workspaceEntries(), {}), null)
    fireEvent.click(await screen.findByText("notes.md"))
    expect(onOpenFile).toHaveBeenCalledWith("notes.md")
    expect(document.activeElement).toBe(fileRow("notes.md"))
    expect(fileRow("notes.md").closest("[data-holds-focus-on-open]")).toBeTruthy()

    fireEvent.keyDown(document.activeElement as Element, { key: "Backspace", metaKey: true })
    const dialog = screen.getByRole("alertdialog")
    expect(dialog.textContent).toContain("notes.md")
  })
})
