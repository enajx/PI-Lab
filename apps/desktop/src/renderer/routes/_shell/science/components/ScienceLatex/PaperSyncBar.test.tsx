import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { PaperSyncBar } from "./PaperSyncBar"

/**
 * Component tests for the LaTeX Editor Sync bar. The tRPC server is a fake
 * (mocked), so these check the UI flow only; the real Git behaviour is covered
 * by the main-process `paper` router tests and the e2e test.
 */
function renderBar(
  handlers: FakeHandlers,
  confirmCommit: boolean,
  onOpenFiles: (files: string[]) => void,
  saveOpenFiles: () => Promise<string[]>,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(handlers)
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <PaperSyncBar
        projectId="p1"
        workspaceId="w1"
        lastSyncAt={null}
        hasRemote={true}
        confirmCommit={confirmCommit}
        outputDir={null}
        defaultOutputDir="build"
        onOpenFiles={onOpenFiles}
        saveOpenFiles={saveOpenFiles}
      />
    </AppProviders>,
  )
}

describe("PaperSyncBar (mocked server)", () => {
  test("asks before committing unsent edits, and Don't ask again turns the question off", async () => {
    const sync = vi.fn((input: unknown) =>
      (input as { commit: boolean }).commit
        ? { state: "synced", lastSyncAt: 1 }
        : { state: "needs-commit", changedFiles: ["main.tex"] },
    )
    const updateEditor = vi.fn(() => ({}))
    renderBar(
      {
        "paper.sync": sync,
        "settings.updateEditor": updateEditor,
        "settings.get": () => ({}),
        "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
      },
      true,
      () => undefined,
      async () => [],
    )
    fireEvent.click(screen.getByTestId("paper-sync"))
    const dialog = await screen.findByTestId("paper-commit-dialog")
    expect(dialog.textContent).toContain("main.tex")
    fireEvent.click(screen.getByTestId("paper-commit-dont-ask"))
    fireEvent.click(screen.getByTestId("paper-commit-confirm"))
    await waitFor(() => expect(sync).toHaveBeenLastCalledWith({ projectId: "p1", commit: true }))
    expect(updateEditor).toHaveBeenCalledWith({ confirmOverleafCommit: false })
    await waitFor(() => expect(screen.queryByTestId("paper-commit-dialog")).toBeNull())
  })

  test("commits without asking when the question is turned off", async () => {
    const sync = vi.fn(() => ({ state: "synced", lastSyncAt: 1 }))
    renderBar(
      {
        "paper.sync": sync,
        "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
      },
      false,
      () => undefined,
      async () => [],
    )
    fireEvent.click(screen.getByTestId("paper-sync"))
    await waitFor(() => expect(sync).toHaveBeenCalledWith({ projectId: "p1", commit: true }))
    expect(screen.queryByTestId("paper-commit-dialog")).toBeNull()
  })

  test("a conflict shows the files and the resolve buttons", async () => {
    const resolve = vi.fn(() => ({ state: "synced", lastSyncAt: 2 }))
    const onOpenFiles = vi.fn()
    renderBar(
      {
        "paper.sync": () => ({ state: "conflict", files: ["intro.tex"] }),
        "paper.resolve": resolve,
        "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
      },
      false,
      onOpenFiles,
      async () => [],
    )
    fireEvent.click(screen.getByTestId("paper-sync"))
    const dialog = await screen.findByTestId("paper-conflict-dialog")
    expect(dialog.textContent).toContain("intro.tex")
    for (const id of [
      "paper-conflict-mine",
      "paper-conflict-overleaf",
      "paper-conflict-agent",
      "paper-conflict-editor",
      "paper-conflict-cancel",
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy()
    }

    fireEvent.click(screen.getByTestId("paper-conflict-editor"))
    expect(onOpenFiles).toHaveBeenCalledWith(["intro.tex"])
    expect(screen.queryByTestId("paper-conflict-dialog")).toBeNull()

    fireEvent.click(screen.getByTestId("paper-sync"))
    await screen.findByTestId("paper-conflict-dialog")
    fireEvent.click(screen.getByTestId("paper-conflict-mine"))
    await waitFor(() => expect(resolve).toHaveBeenCalledWith({ projectId: "p1", choice: "mine" }))
    await waitFor(() => expect(screen.queryByTestId("paper-conflict-dialog")).toBeNull())

    fireEvent.click(screen.getByTestId("paper-sync"))
    await screen.findByTestId("paper-conflict-dialog")
    fireEvent.click(screen.getByTestId("paper-conflict-cancel"))
    expect(screen.queryByTestId("paper-conflict-dialog")).toBeNull()
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  test("an error while the commit question is open is shown in the dialog", async () => {
    renderBar(
      {
        "paper.sync": (input: unknown) => {
          if ((input as { commit: boolean }).commit) throw new Error("push rejected")
          return { state: "needs-commit", changedFiles: ["main.tex"] }
        },
        "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
      },
      true,
      () => undefined,
      async () => [],
    )
    fireEvent.click(screen.getByTestId("paper-sync"))
    await screen.findByTestId("paper-commit-dialog")
    fireEvent.click(screen.getByTestId("paper-commit-confirm"))
    const dialog = screen.getByTestId("paper-commit-dialog")
    await waitFor(() => expect(dialog.textContent).toContain("push rejected"))
  })

  test("Sync saves open edits first, and stops when a file cannot be saved", async () => {
    const order: string[] = []
    const sync = vi.fn(() => {
      order.push("sync")
      return { state: "synced", lastSyncAt: 1 }
    })
    let failed: string[] = []
    renderBar(
      {
        "paper.sync": sync,
        "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
      },
      false,
      () => undefined,
      async () => {
        order.push("save")
        return failed
      },
    )
    fireEvent.click(screen.getByTestId("paper-sync"))
    await waitFor(() => expect(order).toEqual(["save", "sync"]))

    failed = ["intro.tex"]
    fireEvent.click(screen.getByTestId("paper-sync"))
    expect((await screen.findByRole("alert")).textContent).toContain("intro.tex")
    expect(sync).toHaveBeenCalledTimes(1)
  })
  test("sets this paper's output folder on Enter and shows a rejected value", async () => {
    const setOutputDir = vi.fn((input: unknown) => {
      if ((input as { outputDir: string }).outputDir.includes(".."))
        throw new Error('The build output folder cannot contain "..": ../x')
      return { paper: null, workspaceId: null, rootRelPath: null }
    })
    renderBar(
      {
        "paper.setOutputDir": setOutputDir,
        "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
      },
      true,
      () => undefined,
      async () => [],
    )
    const field = screen.getByTestId("paper-output-dir") as HTMLInputElement
    expect(field.placeholder).toBe("build")
    expect(field.value).toBe("")
    fireEvent.change(field, { target: { value: "out/pdf" } })
    fireEvent.keyDown(field, { key: "Enter" })
    await waitFor(() =>
      expect(setOutputDir).toHaveBeenCalledWith({ projectId: "p1", outputDir: "out/pdf" }),
    )
    fireEvent.change(field, { target: { value: "../x" } })
    fireEvent.keyDown(field, { key: "Enter" })
    expect((await screen.findByRole("alert")).textContent).toContain('cannot contain ".."')
  })
})
