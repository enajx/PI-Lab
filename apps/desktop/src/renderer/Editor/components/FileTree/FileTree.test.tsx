import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
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
