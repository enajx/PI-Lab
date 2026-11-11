import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { PaperFolderStatusItem } from "./PaperFolder"

/**
 * Component tests for the LaTeX Editor footer's "Paper folder" item. The tRPC
 * server is a fake (mocked); the e2e test covers the real app.
 */
function renderItem(displayDir: string, handlers: FakeHandlers) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AppProviders client={createFakeTrpcClient(handlers)} queryClient={queryClient}>
      <PaperFolderStatusItem projectId="p1" dir="/real/dir" displayDir={displayDir} />
    </AppProviders>,
  )
}

describe("PaperFolderStatusItem (mocked server)", () => {
  test("shows the folder relative to the project, as the project folder, or as a ~ path", () => {
    for (const [displayDir, shown] of [
      ["paper", "paper"],
      [".", "Project folder"],
      ["~/papers/my-paper", "~/papers/my-paper"],
    ] as const) {
      const view = renderItem(displayDir, {})
      const item = screen.getByTestId("editor-paper-folder")
      expect(item.textContent).toBe(shown)
      expect(item.getAttribute("title")).toContain("/real/dir")
      expect(item.getAttribute("aria-haspopup")).toBe("menu")
      view.unmount()
    }
  })

  test("Choose paper folder… opens the picker and sets the chosen folder", async () => {
    const link = vi.fn(() => ({ paper: null, workspaceId: null, rootRelPath: null }))
    renderItem("paper", {
      "system.pickDirectory": () => "/Users/me/other-paper",
      "paper.checkFolder": () => ({
        displayDir: "~/other-paper",
        projectFolder: false,
        overleaf: false,
        remoteUrl: null,
        isPaper: true,
        inside: [],
        stoppedEarly: false,
      }),
      "paper.link": link,
    })
    fireEvent.click(screen.getByTestId("editor-paper-folder"))
    const menu = screen.getByRole("menu", { name: "Paper folder" })
    fireEvent.click(within(menu).getByTestId("paper-folder-choose"))
    await waitFor(() =>
      expect(link).toHaveBeenCalledWith({
        projectId: "p1",
        dir: "/Users/me/other-paper",
        rootChoice: null,
      }),
    )
  })

  test("choosing the project folder asks first with the same three options", async () => {
    const link = vi.fn(() => ({ paper: null, workspaceId: null, rootRelPath: null }))
    renderItem("paper", {
      "system.pickDirectory": () => "/proj",
      "paper.checkFolder": () => ({
        displayDir: ".",
        projectFolder: true,
        overleaf: false,
        remoteUrl: "https://github.com/u/p.git",
        isPaper: true,
        inside: [],
        stoppedEarly: false,
      }),
      "paper.link": link,
    })
    fireEvent.click(screen.getByTestId("editor-paper-folder"))
    fireEvent.click(screen.getByTestId("paper-folder-choose"))
    const dialog = await screen.findByTestId("paper-root-dialog")
    expect(within(dialog).getByTestId("paper-root-no-sync")).toBeTruthy()
    expect(within(dialog).getByTestId("paper-root-sync")).toBeTruthy()
    expect(within(dialog).getByTestId("paper-root-other")).toBeTruthy()
    expect(link).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByTestId("paper-root-no-sync"))
    await waitFor(() =>
      expect(link).toHaveBeenCalledWith({ projectId: "p1", dir: "/proj", rootChoice: "no-sync" }),
    )
  })

  test("a folder that is not a paper lists the papers inside it; choosing one uses it", async () => {
    const link = vi.fn(() => ({ paper: null, workspaceId: null, rootRelPath: null }))
    const check = vi.fn((input: unknown) => {
      const { dir } = input as { dir: string }
      return dir === "/Users/me/papers"
        ? {
            displayDir: "~/papers",
            projectFolder: false,
            overleaf: false,
            remoteUrl: null,
            isPaper: false,
            inside: [
              { dir: "/Users/me/papers/a", relPath: "a", overleaf: false },
              { dir: "/Users/me/papers/group/b", relPath: "group/b", overleaf: true },
            ],
            stoppedEarly: false,
          }
        : {
            displayDir: "~/papers/group/b",
            projectFolder: false,
            overleaf: true,
            remoteUrl: "https://git.overleaf.com/abc",
            isPaper: true,
            inside: [],
            stoppedEarly: false,
          }
    })
    renderItem("paper", {
      "system.pickDirectory": () => "/Users/me/papers",
      "paper.checkFolder": check,
      "paper.link": link,
    })
    fireEvent.click(screen.getByTestId("editor-paper-folder"))
    fireEvent.click(screen.getByTestId("paper-folder-choose"))
    const dialog = await screen.findByTestId("paper-not-paper-dialog")
    expect(dialog.textContent).toContain(
      "This folder is not a paper folder. Papers found inside it:",
    )
    const options = within(dialog).getAllByTestId("paper-inside-option")
    expect(options.map((option) => option.getAttribute("data-rel-path"))).toEqual(["a", "group/b"])
    expect(options[0]?.textContent).toBe("a")
    expect(options[1]?.textContent).toBe("group/bOverleaf")
    expect(link).not.toHaveBeenCalled()
    fireEvent.click(options[1] as HTMLElement)
    await waitFor(() =>
      expect(link).toHaveBeenCalledWith({
        projectId: "p1",
        dir: "/Users/me/papers/group/b",
        rootChoice: null,
      }),
    )
    expect(check).toHaveBeenCalledWith({ projectId: "p1", dir: "/Users/me/papers/group/b" })
    expect(screen.queryByTestId("paper-not-paper-dialog")).toBeNull()
  })

  test("a folder with no papers inside says so; Choose another folder opens the picker again, Cancel closes", async () => {
    const pick = vi.fn(() => "/Users/me/empty")
    const link = vi.fn(() => undefined)
    renderItem("paper", {
      "system.pickDirectory": pick,
      "paper.checkFolder": () => ({
        displayDir: "~/empty",
        projectFolder: false,
        overleaf: false,
        remoteUrl: null,
        isPaper: false,
        inside: [],
        stoppedEarly: false,
      }),
      "paper.link": link,
    })
    fireEvent.click(screen.getByTestId("editor-paper-folder"))
    fireEvent.click(screen.getByTestId("paper-folder-choose"))
    const dialog = await screen.findByTestId("paper-not-paper-dialog")
    expect(dialog.textContent).toContain(
      "This folder has no LaTeX files. Choose the paper's own folder.",
    )
    expect(within(dialog).queryByTestId("paper-inside-option")).toBeNull()
    fireEvent.click(within(dialog).getByTestId("paper-not-paper-other"))
    await waitFor(() => expect(pick).toHaveBeenCalledTimes(2))
    fireEvent.click(
      within(await screen.findByTestId("paper-not-paper-dialog")).getByTestId(
        "paper-not-paper-cancel",
      ),
    )
    expect(screen.queryByTestId("paper-not-paper-dialog")).toBeNull()
    expect(link).not.toHaveBeenCalled()
  })

  test("Clear paper folder forgets the folder", async () => {
    const unlink = vi.fn(() => ({ ok: true }))
    renderItem("paper", { "paper.unlink": unlink })
    fireEvent.click(screen.getByTestId("editor-paper-folder"))
    fireEvent.click(screen.getByTestId("paper-folder-clear"))
    await waitFor(() => expect(unlink).toHaveBeenCalledWith({ projectId: "p1" }))
  })

  test("a failed change is shown", async () => {
    renderItem("paper", {
      "paper.unlink": () => {
        throw new Error("could not clear")
      },
    })
    fireEvent.click(screen.getByTestId("editor-paper-folder"))
    fireEvent.click(screen.getByTestId("paper-folder-clear"))
    expect((await screen.findByRole("alert")).textContent).toContain("could not clear")
  })
})

/** Every `t("…")` string in the LaTeX Editor's components (not tests). */
function uiStrings(): string[] {
  const dir = __dirname
  const files = readdirSync(dir).filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
  return files.flatMap((name) =>
    [...readFileSync(join(dir, name), "utf8").matchAll(/\bt\(\s*"([^"]*)"/g)].map(
      (match) => match[1] ?? "",
    ),
  )
}

test("LaTeX Editor UI text never says link, linked or unlink for the paper", () => {
  const strings = uiStrings()
  expect(strings.length).toBeGreaterThan(20)
  expect(strings.filter((text) => /\b(un)?link(ed|ing|s)?\b/i.test(text))).toEqual([])
})
