import { QueryClient } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { formatLastSync, PaperSyncBar } from "./PaperSyncBar"

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
  return renderBarWithSync(handlers, confirmCommit, onOpenFiles, saveOpenFiles, true, null)
}

/** {@link renderBar} with Sync on or off for the paper. */
function renderBarWithSync(
  handlers: FakeHandlers,
  confirmCommit: boolean,
  onOpenFiles: (files: string[]) => void,
  saveOpenFiles: () => Promise<string[]>,
  syncEnabled: boolean,
  lastSyncAt: number | null,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(handlers)
  // Stands in for the page top bar that holds the Sync button.
  const syncSlot = document.createElement("div")
  syncSlot.dataset.testid = "top-bar-slot"
  document.body.appendChild(syncSlot)
  // Stands in for the thin editor footer that holds the other Sync items.
  const footerSlot = document.createElement("div")
  footerSlot.dataset.testid = "footer-slot"
  document.body.appendChild(footerSlot)
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <PaperSyncBar
        projectId="p1"
        workspaceId="w1"
        syncSlot={syncSlot}
        footerSlot={footerSlot}
        lastSyncAt={lastSyncAt}
        hasRemote={true}
        syncEnabled={syncEnabled}
        confirmCommit={confirmCommit}
        outputDir={null}
        defaultOutputDir="build"
        mainDoc="main.tex"
        chosenMainDoc={null}
        texFiles={["main.tex", "other.tex"]}
        onOpenFiles={onOpenFiles}
        saveOpenFiles={saveOpenFiles}
      />
    </AppProviders>,
  )
}

afterEach(() => {
  vi.useRealTimers()
})

describe("PaperSyncBar (mocked server)", () => {
  test("with Sync off for the paper, the top bar says so instead of showing the Sync button", () => {
    const sync = vi.fn(() => ({ state: "synced", lastSyncAt: 1 }))
    renderBarWithSync(
      { "paper.sync": sync },
      false,
      () => undefined,
      async () => [],
      false,
      null,
    )
    const slot = screen.getAllByTestId("top-bar-slot").at(-1) as HTMLElement
    const footer = screen.getAllByTestId("footer-slot").at(-1) as HTMLElement
    expect(within(footer).queryByTestId("paper-last-sync")).toBeNull()
    expect(within(slot).queryByTestId("paper-sync")).toBeNull()
    expect(within(slot).queryByTestId("paper-last-sync")).toBeNull()
    expect(within(slot).getByTestId("paper-sync-off").textContent).toBe(
      "Sync is off for this paper",
    )
    expect(sync).not.toHaveBeenCalled()
  })

  test("the Sync button goes in the top bar; the last sync time and Sync errors go in the footer, and there is no bottom bar", async () => {
    renderBar(
      {
        "paper.sync": () => {
          throw new Error("push rejected")
        },
        "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
      },
      false,
      () => undefined,
      async () => [],
    )
    const slot = screen.getAllByTestId("top-bar-slot").at(-1) as HTMLElement
    const footer = screen.getAllByTestId("footer-slot").at(-1) as HTMLElement
    expect(screen.queryByTestId("paper-sync-bar")).toBeNull()
    expect(within(slot).getByTestId("paper-sync")).toBeTruthy()
    expect(within(slot).queryByTestId("paper-last-sync")).toBeNull()
    expect(within(footer).getByTestId("paper-last-sync").textContent).toBe("Not synced yet")
    expect(within(footer).getByTestId("paper-output-folder")).toBeTruthy()
    fireEvent.click(within(slot).getByTestId("paper-sync"))
    const alert = await within(footer).findByRole("alert")
    expect(alert.textContent).toContain("push rejected")
    expect(alert.getAttribute("title")).toContain("push rejected")
  })

  test("a paper folder without a Git remote shows the notice in the footer", async () => {
    renderBar(
      {
        "paper.sync": () => ({ state: "no-remote" }),
        "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
      },
      false,
      () => undefined,
      async () => [],
    )
    fireEvent.click(screen.getByTestId("paper-sync"))
    const footer = screen.getAllByTestId("footer-slot").at(-1) as HTMLElement
    const notice = await within(footer).findByTestId("paper-sync-notice")
    expect(notice.textContent).toBe("This paper folder has no Git remote to sync with.")
    expect(notice.getAttribute("title")).toBe(notice.textContent)
  })

  test("the footer's last sync time says how long ago and refreshes over time", () => {
    vi.useFakeTimers({ now: 1_000_000_000_000 })
    renderBarWithSync(
      { "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }) },
      false,
      () => undefined,
      async () => [],
      true,
      1_000_000_000_000 - 20_000,
    )
    const footer = screen.getAllByTestId("footer-slot").at(-1) as HTMLElement
    const lastSync = within(footer).getByTestId("paper-last-sync")
    expect(lastSync.textContent).toBe("Synced just now")
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(lastSync.textContent).toBe("Synced 1 minute ago")
  })

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
    const footer = screen.getAllByTestId("footer-slot").at(-1) as HTMLElement
    expect((await within(footer).findByRole("alert")).textContent).toBe(
      "Could not save, so Sync did not run: intro.tex",
    )
    expect(sync).toHaveBeenCalledTimes(1)
  })
  test("the footer's main document and output folder item is one short item; its popover sets the main document", async () => {
    const setMainDoc = vi.fn(() => ({ paper: null, workspaceId: null, rootRelPath: null }))
    renderBar(
      {
        "paper.setMainDoc": setMainDoc,
        "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
      },
      true,
      () => undefined,
      async () => [],
    )
    const footer = screen.getAllByTestId("footer-slot").at(-1) as HTMLElement
    const item = within(footer).getByTestId("paper-output-folder")
    expect(item.textContent).toBe("main.tex · build/")
    fireEvent.click(item)
    const select = within(footer).getByTestId("paper-main-doc") as HTMLSelectElement
    expect([...select.options].map((option) => option.value)).toEqual(["", "main.tex", "other.tex"])
    expect(select.value).toBe("")
    fireEvent.change(select, { target: { value: "other.tex" } })
    await waitFor(() =>
      expect(setMainDoc).toHaveBeenCalledWith({ projectId: "p1", mainDoc: "other.tex" }),
    )
    // The popover stays open so the output folder can be changed too.
    expect(within(footer).getByTestId("paper-output-dir")).toBeTruthy()
    // "What's this?" help: each control has its own title and body.
    for (const id of ["paper-output-folder", "paper-main-doc", "paper-output-dir"]) {
      const control = within(footer).getByTestId(id)
      expect(control.dataset.featureLabel, id).toBeTruthy()
      expect(control.dataset.featureHelp, id).toBeTruthy()
    }
  })
  test("the footer's output folder item opens a popover that sets the folder on Enter and shows a rejected value", async () => {
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
    const footer = screen.getAllByTestId("footer-slot").at(-1) as HTMLElement
    const item = within(footer).getByTestId("paper-output-folder")
    expect(item.textContent).toBe("main.tex · build/")
    expect(screen.queryByTestId("paper-output-dir")).toBeNull()
    fireEvent.click(item)
    const field = within(footer).getByTestId("paper-output-dir") as HTMLInputElement
    expect(field.placeholder).toBe("build")
    expect(field.value).toBe("")
    // Escape closes the popover without applying.
    fireEvent.keyDown(field, { key: "Escape" })
    expect(screen.queryByTestId("paper-output-dir")).toBeNull()

    fireEvent.click(item)
    fireEvent.change(screen.getByTestId("paper-output-dir"), { target: { value: "out/pdf" } })
    fireEvent.keyDown(screen.getByTestId("paper-output-dir"), { key: "Enter" })
    await waitFor(() =>
      expect(setOutputDir).toHaveBeenCalledWith({ projectId: "p1", outputDir: "out/pdf" }),
    )
    // Applied: the popover closes.
    await waitFor(() => expect(screen.queryByTestId("paper-output-dir")).toBeNull())

    fireEvent.click(item)
    fireEvent.change(screen.getByTestId("paper-output-dir"), { target: { value: "../x" } })
    fireEvent.keyDown(screen.getByTestId("paper-output-dir"), { key: "Enter" })
    const popover = screen.getByTestId("paper-output-popover")
    expect((await within(popover).findByRole("alert")).textContent).toContain('cannot contain ".."')
    expect(screen.getByTestId("paper-output-dir")).toBeTruthy()
  })
})

describe("formatLastSync", () => {
  const now = 1_000_000_000_000
  const MINUTE = 60_000
  const HOUR = 60 * MINUTE
  const DAY = 24 * HOUR
  test("says how long ago the last sync was in minutes, hours or days", () => {
    expect(formatLastSync(null, now)).toBe("Not synced yet")
    expect(formatLastSync(now - 20_000, now)).toBe("Synced just now")
    expect(formatLastSync(now - MINUTE, now)).toBe("Synced 1 minute ago")
    expect(formatLastSync(now - 5 * MINUTE, now)).toBe("Synced 5 minutes ago")
    expect(formatLastSync(now - HOUR, now)).toBe("Synced 1 hour ago")
    expect(formatLastSync(now - 3 * HOUR, now)).toBe("Synced 3 hours ago")
    expect(formatLastSync(now - DAY, now)).toBe("Synced 1 day ago")
    expect(formatLastSync(now - 7 * DAY, now)).toBe("Synced 7 days ago")
  })
})
