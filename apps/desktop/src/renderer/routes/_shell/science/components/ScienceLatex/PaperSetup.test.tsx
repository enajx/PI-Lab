import { DEFAULT_EDITOR_SETTINGS } from "@pi-lab/local-db/editor-settings"
import { buttonVariants, cn } from "@pi-lab/ui"
import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { type CreatedPaper, PaperSetup } from "./PaperSetup"

/**
 * Component tests for linking a paper to a project. The tRPC server is a fake
 * (mocked); cloning and linking for real are covered by the `paper` router tests
 * and the e2e test.
 */
/** What PaperSetup reported about Start draft, in order: "start", then the created paper or null. */
let created: ("start" | CreatedPaper | null)[] = []

function renderSetup(handlers: FakeHandlers) {
  return renderSetupWith(handlers, true)
}

/** {@link renderSetup} with auto-detection on or off (off after the user cleared the folder). */
function renderSetupWith(handlers: FakeHandlers, autoDetect: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient({
    "paper.detect": () => ({ clones: [], stoppedEarly: false }),
    "paper.createTarget": () => ({ dir: "/p/paper", displayDir: "paper" }),
    // "Inside the project" is remembered, so Add Overleaf project clones without the
    // destination question (that question is covered by the LaTeX Editor e2e test).
    "settings.get": () => ({
      editor: { ...DEFAULT_EDITOR_SETTINGS, overleafCloneLocation: "project" },
    }),
    ...handlers,
  })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <PaperSetup
        projectId="p1"
        autoDetect={autoDetect}
        onCreateStart={() => created.push("start")}
        onCreated={(paper) => created.push(paper)}
        onAdded={() => undefined}
      />
    </AppProviders>,
  )
}

const OVERLEAF_URL = "https://git@git.overleaf.com/6ae5e243374fe1802d83e27a"

describe("PaperSetup (mocked server)", () => {
  test("asks for the Overleaf token when none is saved, and sends it with the clone (not saved first)", async () => {
    const setToken = vi.fn(() => undefined)
    const addOverleaf = vi.fn(() => undefined)
    renderSetup({
      "paper.token.status": () => ({ configured: false, source: null }),
      "paper.token.set": setToken,
      "paper.addOverleaf": addOverleaf,
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    fireEvent.change(await screen.findByTestId("paper-overleaf-url"), {
      target: { value: OVERLEAF_URL },
    })
    const token = await screen.findByTestId("paper-overleaf-token")
    fireEvent.change(token, { target: { value: "olp_secret" } })
    fireEvent.click(screen.getByTestId("paper-overleaf-add"))
    await waitFor(() =>
      expect(addOverleaf).toHaveBeenCalledWith({
        projectId: "p1",
        url: OVERLEAF_URL,
        dir: null,
        token: "olp_secret",
      }),
    )
    expect(setToken).not.toHaveBeenCalled()
  })

  test("after a failed clone with a typed token, the error and the token field stay", async () => {
    renderSetup({
      "paper.token.status": () => ({ configured: false, source: null }),
      "paper.addOverleaf": () => {
        throw new Error("Authentication failed")
      },
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    fireEvent.change(await screen.findByTestId("paper-overleaf-url"), {
      target: { value: OVERLEAF_URL },
    })
    fireEvent.change(await screen.findByTestId("paper-overleaf-token"), {
      target: { value: "olp_wrong" },
    })
    fireEvent.click(screen.getByTestId("paper-overleaf-add"))
    expect((await screen.findByRole("alert")).textContent).toContain("Authentication failed")
    expect(screen.getByTestId("paper-overleaf-token")).toBeTruthy()
  })

  test("does not ask for the token again once it is saved", async () => {
    const addOverleaf = vi.fn(() => undefined)
    renderSetup({
      "paper.token.status": () => ({ configured: true, source: "saved" }),
      "paper.addOverleaf": addOverleaf,
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    fireEvent.change(await screen.findByTestId("paper-overleaf-url"), {
      target: { value: OVERLEAF_URL },
    })
    await waitFor(() =>
      expect((screen.getByTestId("paper-overleaf-add") as HTMLButtonElement).disabled).toBe(false),
    )
    expect(screen.queryByTestId("paper-overleaf-token")).toBeNull()
    fireEvent.click(screen.getByTestId("paper-overleaf-add"))
    await waitFor(() => expect(addOverleaf).toHaveBeenCalled())
  })

  test("links a folder the user already cloned", async () => {
    const link = vi.fn(() => undefined)
    renderSetup({
      "paper.token.status": () => ({ configured: true, source: "saved" }),
      "system.pickDirectory": () => "/Users/me/papers/my-paper",
      "paper.checkFolder": () => ({
        projectFolder: false,
        overleaf: false,
        remoteUrl: null,
        isPaper: true,
        inside: [],
        stoppedEarly: false,
      }),
      "paper.link": link,
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    fireEvent.click(await screen.findByTestId("paper-use-folder"))
    await waitFor(() =>
      expect(link).toHaveBeenCalledWith({
        projectId: "p1",
        dir: "/Users/me/papers/my-paper",
        rootChoice: null,
      }),
    )
  })

  test("a chosen folder that is not a paper shows the papers inside it instead of being used", async () => {
    const link = vi.fn(() => undefined)
    renderSetup({
      "paper.token.status": () => ({ configured: true, source: "saved" }),
      "system.pickDirectory": () => "/Users/me/papers",
      "paper.checkFolder": (input) =>
        (input as { dir: string }).dir === "/Users/me/papers"
          ? {
              displayDir: "~/papers",
              projectFolder: false,
              overleaf: false,
              remoteUrl: null,
              isPaper: false,
              inside: [{ dir: "/Users/me/papers/a", relPath: "a", overleaf: false }],
              stoppedEarly: false,
            }
          : {
              displayDir: "~/papers/a",
              projectFolder: false,
              overleaf: false,
              remoteUrl: null,
              isPaper: true,
              inside: [],
              stoppedEarly: false,
            },
      "paper.link": link,
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    fireEvent.click(await screen.findByTestId("paper-use-folder"))
    const dialog = await screen.findByTestId("paper-not-paper-dialog")
    expect(link).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByTestId("paper-inside-option"))
    await waitFor(() =>
      expect(link).toHaveBeenCalledWith({
        projectId: "p1",
        dir: "/Users/me/papers/a",
        rootChoice: null,
      }),
    )
  })

  test("links the one Overleaf clone found in the project without showing the setup", async () => {
    const link = vi.fn(() => ({ paper: null, workspaceId: null, rootRelPath: null }))
    renderSetup({
      "paper.token.status": () => ({ configured: true, source: "saved" }),
      "paper.detect": () => ({
        clones: [{ dir: "/proj/paper", relPath: "paper" }],
        stoppedEarly: false,
      }),
      "paper.link": link,
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    await waitFor(() =>
      expect(link).toHaveBeenCalledWith({ projectId: "p1", dir: "/proj/paper", rootChoice: null }),
    )
    expect(link).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("paper-setup-overleaf")).toBeNull()
  })

  test("with auto-detection off (folder cleared), shows the two cards and neither searches nor sets a folder", async () => {
    const detect = vi.fn(() => ({
      clones: [{ dir: "/proj/paper", relPath: "paper" }],
      stoppedEarly: false,
    }))
    const link = vi.fn(() => undefined)
    renderSetupWith(
      {
        "paper.token.status": () => ({ configured: true, source: "saved" }),
        "paper.detect": detect,
        "paper.link": link,
        "paper.get": () => ({
          paper: null,
          workspaceId: null,
          rootRelPath: null,
          autoDetect: false,
        }),
      },
      false,
    )
    expect(await screen.findByTestId("paper-setup-overleaf")).toBeTruthy()
    expect(screen.getByTestId("paper-setup-folder")).toBeTruthy()
    expect(screen.queryByTestId("paper-detecting")).toBeNull()
    expect(screen.queryByTestId("paper-detected")).toBeNull()
    expect(detect).not.toHaveBeenCalled()
    expect(link).not.toHaveBeenCalled()
  })

  test("with several Overleaf clones, asks which one to link", async () => {
    const link = vi.fn(() => undefined)
    renderSetup({
      "paper.token.status": () => ({ configured: true, source: "saved" }),
      "paper.detect": () => ({
        clones: [
          { dir: "/proj", relPath: "." },
          { dir: "/proj/paper", relPath: "paper" },
        ],
        stoppedEarly: false,
      }),
      "paper.link": link,
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    const chooser = await screen.findByTestId("paper-detected")
    const options = within(chooser).getAllByTestId("paper-detected-option")
    expect(options.map((option) => option.textContent)).toEqual(["Project folder (.)", "paper"])
    expect(link).not.toHaveBeenCalled()
    fireEvent.click(options[1] as HTMLElement)
    await waitFor(() =>
      expect(link).toHaveBeenCalledWith({ projectId: "p1", dir: "/proj/paper", rootChoice: null }),
    )
  })

  test("with no Overleaf clone found, shows the two setup cards", async () => {
    renderSetup({
      "paper.token.status": () => ({ configured: true, source: "saved" }),
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    expect(await screen.findByTestId("paper-setup-overleaf")).toBeTruthy()
    expect(screen.getByTestId("paper-setup-folder")).toBeTruthy()
    expect(screen.queryByTestId("paper-detected")).toBeNull()
    expect(screen.queryByTestId("paper-detect-stopped")).toBeNull()
  })

  test("says when the search for Overleaf folders stopped early", async () => {
    renderSetup({
      "paper.token.status": () => ({ configured: true, source: "saved" }),
      "paper.detect": () => ({ clones: [], stoppedEarly: true }),
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    expect((await screen.findByTestId("paper-detect-stopped")).textContent).toBe(
      "This project has many folders, so the search for Overleaf folders stopped early. Choose the folder below if it was not found.",
    )
    expect(screen.getByTestId("paper-setup-folder")).toBeTruthy()
  })

  test("an Overleaf clone project folder is linked with no question", async () => {
    const link = vi.fn(() => undefined)
    renderSetup({
      "paper.token.status": () => ({ configured: true, source: "saved" }),
      "system.pickDirectory": () => "/proj",
      "paper.checkFolder": () => ({
        projectFolder: true,
        overleaf: true,
        remoteUrl: "https://git@git.overleaf.com/abc",
        isPaper: true,
        inside: [],
        stoppedEarly: false,
      }),
      "paper.link": link,
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    fireEvent.click(await screen.findByTestId("paper-use-folder"))
    await waitFor(() =>
      expect(link).toHaveBeenCalledWith({ projectId: "p1", dir: "/proj", rootChoice: null }),
    )
    expect(screen.queryByTestId("paper-root-dialog")).toBeNull()
  })

  test("another project folder asks first: edit and build only, or with Sync", async () => {
    for (const [button, rootChoice] of [
      ["paper-root-no-sync", "no-sync"],
      ["paper-root-sync", "sync"],
    ] as const) {
      const link = vi.fn(() => undefined)
      const view = renderSetup({
        "paper.token.status": () => ({ configured: true, source: "saved" }),
        "system.pickDirectory": () => "/proj",
        "paper.checkFolder": () => ({
          projectFolder: true,
          overleaf: false,
          remoteUrl: "https://github.com/u/p.git",
          isPaper: true,
          inside: [],
          stoppedEarly: false,
        }),
        "paper.link": link,
        "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
      })
      fireEvent.click(await screen.findByTestId("paper-use-folder"))
      const dialog = await screen.findByTestId("paper-root-dialog")
      expect(dialog.textContent).toContain("https://github.com/u/p.git")
      expect(within(dialog).getByTestId("paper-root-no-sync").textContent).toBe(
        "Use it, edit and build only (no Sync)",
      )
      expect(within(dialog).getByTestId("paper-root-sync").textContent).toBe("Use it with Sync")
      expect(within(dialog).getByTestId("paper-root-other").textContent).toBe(
        "Choose another folder",
      )
      expect(link).not.toHaveBeenCalled()
      fireEvent.click(within(dialog).getByTestId(button))
      await waitFor(() =>
        expect(link).toHaveBeenCalledWith({ projectId: "p1", dir: "/proj", rootChoice }),
      )
      expect(screen.queryByTestId("paper-root-dialog")).toBeNull()
      view.unmount()
    }
  })

  test("another project folder with no remote says so; Choose another folder opens the picker again", async () => {
    const pick = vi.fn(() => "/proj")
    renderSetup({
      "paper.token.status": () => ({ configured: true, source: "saved" }),
      "system.pickDirectory": pick,
      "paper.checkFolder": () => ({
        projectFolder: true,
        overleaf: false,
        remoteUrl: null,
        isPaper: true,
        inside: [],
        stoppedEarly: false,
      }),
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    fireEvent.click(await screen.findByTestId("paper-use-folder"))
    const dialog = await screen.findByTestId("paper-root-dialog")
    expect(dialog.textContent).toContain("has no Git remote")
    expect(within(dialog).getByTestId("paper-root-no-sync")).toBeTruthy()
    expect(within(dialog).queryByTestId("paper-root-sync")).toBeNull()
    fireEvent.click(within(dialog).getByTestId("paper-root-other"))
    await waitFor(() => expect(pick).toHaveBeenCalledTimes(2))
  })

  test("shows a server error", async () => {
    renderSetup({
      "paper.token.status": () => ({ configured: true, source: "saved" }),
      "paper.addOverleaf": () => {
        throw new Error("paper/ already exists in this project")
      },
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    fireEvent.change(await screen.findByTestId("paper-overleaf-url"), {
      target: { value: OVERLEAF_URL },
    })
    await waitFor(() =>
      expect((screen.getByTestId("paper-overleaf-add") as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId("paper-overleaf-add"))
    expect((await screen.findByRole("alert")).textContent).toContain("already exists")
  })

  test("with a saved token, the token and docs links are hidden", async () => {
    renderSetup({
      "paper.token.status": () => ({ configured: true, source: "saved" }),
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    const card = await screen.findByTestId("paper-setup-overleaf")
    await waitFor(() => expect(within(card).queryByRole("link")).toBeNull())
    expect(screen.queryByTestId("paper-overleaf-token-found")).toBeNull()
  })

  test("the page has the Library source chooser's layout: a short heading, three cards in a row, and padding on every side", async () => {
    renderSetup({
      "paper.token.status": () => ({ configured: false, source: null }),
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    // The page fills the area below the top bar and scrolls when it is too short.
    await screen.findByTestId("paper-setup-overleaf")
    const page = screen.getByTestId("paper-setup")
    expect(page.className).toContain("flex-1")
    expect(page.className).toContain("overflow-y-auto")
    // As in the Library: centred, at most 48rem wide, with 1.5rem padding on every side.
    const content = screen.getByTestId("paper-setup-content")
    expect(content.parentElement).toBe(page)
    expect(content.className).toContain("mx-auto")
    expect(content.className).toContain("max-w-3xl")
    expect(content.className).toMatch(/(^|\s)p-6(\s|$)/)
    // A heading and one line of text above the cards, as in the Library.
    expect(
      within(content).getByRole("heading", { level: 2, name: "Choose a paper folder" }),
    ).toBeTruthy()
    // Three columns 0.75rem apart; grid items stretch, so the cards have the same height.
    const grid = screen.getByTestId("paper-setup-overleaf").parentElement as HTMLElement
    expect(grid.className).toContain("grid")
    expect(grid.className).toContain("sm:grid-cols-3")
    expect(grid.className).toMatch(/(^|\s)gap-3(\s|$)/)
    expect(grid.className).not.toMatch(/items-(start|center|end)/)
    // The Library's card: rounded border, light card background, 1rem padding, left-aligned text.
    for (const card of [
      screen.getByTestId("paper-setup-overleaf"),
      screen.getByTestId("paper-setup-folder"),
      screen.getByTestId("paper-setup-create"),
    ]) {
      for (const name of ["rounded-lg", "border", "bg-card/40", "p-4", "flex-col"]) {
        expect(card.className.split(" ")).toContain(name)
      }
      expect(card.className).not.toContain("text-center")
    }
    // The buttons are the shared small primary Button the Library cards use.
    const libraryButton = cn(buttonVariants({ size: "sm" }))
    for (const id of ["paper-overleaf-add", "paper-use-folder", "paper-create"]) {
      expect(screen.getByTestId(id).getAttribute("data-slot")).toBe("button")
      expect(screen.getByTestId(id).className).toBe(libraryButton)
    }
  })

  test("the cards keep the text short", async () => {
    renderSetup({
      "paper.token.status": () => ({ configured: false, source: null }),
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    const overleaf = await screen.findByTestId("paper-setup-overleaf")
    const folder = screen.getByTestId("paper-setup-folder")
    // One short line at most: no line repeating the card title.
    expect(overleaf.textContent).not.toContain("Clone your Overleaf project")
    expect(folder.textContent).toContain("Open a paper folder.")
    expect(screen.getByTestId("paper-use-folder").textContent).toBe("Open folder…")
    await screen.findByTestId("paper-overleaf-token")
    expect(overleaf.textContent).not.toContain("keychain")
  })

  test("long text in the cards wraps instead of being cut", async () => {
    renderSetup({
      "paper.token.status": () => ({ configured: false, source: null }),
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
      "paper.createTarget": () => ({
        dir: "/p/a-long-folder-name-for-the-new-paper",
        displayDir: "a-long-folder-name-for-the-new-paper",
      }),
    })
    const folder = await screen.findByTestId("paper-create-folder")
    await waitFor(() => expect(folder.textContent).toBe("a-long-folder-name-for-the-new-paper/"))
    for (const name of ["truncate", "overflow-hidden", "whitespace-nowrap", "text-ellipsis"]) {
      expect(folder.className.split(" ")).not.toContain(name)
    }
    expect(folder.className).toContain("wrap-anywhere")
    // The folder line and the token links wrap onto a second line when the card is narrow.
    expect((folder.parentElement as HTMLElement).className).toContain("flex-wrap")
    const card = screen.getByTestId("paper-setup-overleaf")
    const links = (await within(card).findByRole("link", { name: "Get a Git token" }))
      .parentElement as HTMLElement
    expect(links.className).toContain("flex-wrap")
  })

  test("links to the Overleaf token page and the Git docs open in the browser", async () => {
    renderSetup({
      "paper.token.status": () => ({ configured: false, source: null }),
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    const card = await screen.findByTestId("paper-setup-overleaf")
    const token = await within(card).findByRole("link", { name: "Get a Git token" })
    const docs = within(card).getByRole("link", { name: "How Overleaf Git works" })
    expect(token.getAttribute("href")).toBe("https://www.overleaf.com/user/settings")
    expect(docs.getAttribute("href")).toBe(
      "https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration",
    )
    // A new-window link is how the app hands a URL to the user's browser.
    for (const link of [token, docs]) {
      expect(link.getAttribute("target")).toBe("_blank")
      expect(link.getAttribute("rel")).toBe("noreferrer")
    }
  })

  test("with Overleaf Git detected, the token field and the token and docs links are hidden", async () => {
    const addOverleaf = vi.fn(() => undefined)
    renderSetup({
      "paper.token.status": () => ({ configured: true, source: "git" }),
      "paper.addOverleaf": addOverleaf,
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    expect((await screen.findByTestId("paper-overleaf-token-found")).textContent).toBe(
      "Overleaf Git detected",
    )
    expect(screen.queryByTestId("paper-overleaf-token")).toBeNull()
    const card = screen.getByTestId("paper-setup-overleaf")
    expect(within(card).queryByRole("link")).toBeNull()
    fireEvent.change(await screen.findByTestId("paper-overleaf-url"), {
      target: { value: OVERLEAF_URL },
    })
    fireEvent.click(screen.getByTestId("paper-overleaf-add"))
    await waitFor(() =>
      expect(addOverleaf).toHaveBeenCalledWith({ projectId: "p1", url: OVERLEAF_URL, dir: null }),
    )
  })

  test("Start draft creates the paper in <project>/paper, or in the folder the user chose", async () => {
    created = []
    const create = vi.fn(() => ({
      paper: null,
      workspaceId: "new-paper-ws",
      rootRelPath: "main.tex",
      autoDetect: true,
    }))
    renderSetup({
      "paper.token.status": () => ({ configured: true, source: "saved" }),
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
      "paper.create": create,
      "pdf.build": () => ({ relPath: "build/main.pdf", success: true, log: "" }),
      "system.pickDirectory": () => "/elsewhere/new-paper",
      "paper.canCreateIn": () => true,
    })
    expect((await screen.findByTestId("paper-create-folder")).textContent).toBe("paper/")
    await waitFor(() =>
      expect((screen.getByTestId("paper-create") as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId("paper-create"))
    await waitFor(() => expect(create).toHaveBeenCalledWith({ projectId: "p1", dir: "/p/paper" }))
    // The page is told which paper workspace was just created, with its PDF build.
    await waitFor(() => expect(created).toHaveLength(2))
    expect((created[1] as CreatedPaper).workspaceId).toBe("new-paper-ws")
    fireEvent.click(screen.getByTestId("paper-create-change"))
    await waitFor(() =>
      expect(screen.getByTestId("paper-create-folder").textContent).toBe("/elsewhere/new-paper"),
    )
    fireEvent.click(screen.getByTestId("paper-create"))
    await waitFor(() =>
      expect(create).toHaveBeenLastCalledWith({ projectId: "p1", dir: "/elsewhere/new-paper" }),
    )
  })

  test("Start draft builds main.tex before the editor opens, showing Building PDF… meanwhile", async () => {
    created = []
    const builds: unknown[] = []
    let finishBuild: (result: unknown) => void = () => undefined
    renderSetup({
      "paper.token.status": () => ({ configured: true, source: "saved" }),
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
      "paper.create": () => ({
        paper: null,
        workspaceId: "new-paper-ws",
        rootRelPath: "main.tex",
        autoDetect: true,
      }),
      "pdf.build": (input) => {
        builds.push(input)
        return new Promise((resolve) => {
          finishBuild = resolve
        })
      },
    })
    const button = (await screen.findByTestId("paper-create")) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    await waitFor(() => expect(button.textContent).toBe("Building PDF…"))
    expect(builds).toEqual([{ workspaceId: "new-paper-ws", relPath: "main.tex" }])
    // The editor is not shown yet: the page only knows a create is running.
    expect(created).toEqual(["start"])
    finishBuild({ relPath: "build/main.pdf", success: true, log: "" })
    await waitFor(() => expect(created).toHaveLength(2))
    const paper = created[1] as CreatedPaper
    expect(paper.workspaceId).toBe("new-paper-ws")
    await expect(paper.build).resolves.toEqual({
      relPath: "build/main.pdf",
      success: true,
      log: "",
    })
  })

  test("Start draft's build that cannot run still opens the paper, with the error for the editor to show", async () => {
    created = []
    renderSetup({
      "paper.token.status": () => ({ configured: true, source: "saved" }),
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
      "paper.create": () => ({
        paper: null,
        workspaceId: "new-paper-ws",
        rootRelPath: "main.tex",
        autoDetect: true,
      }),
      "pdf.build": () => {
        throw new Error("No LaTeX engine found")
      },
    })
    const button = (await screen.findByTestId("paper-create")) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    await waitFor(() => expect(created).toHaveLength(2))
    await expect((created[1] as CreatedPaper).build).rejects.toThrow("No LaTeX engine found")
  })

  test("when Start draft fails, the page is told and the error is shown", async () => {
    created = []
    renderSetup({
      "paper.token.status": () => ({ configured: true, source: "saved" }),
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
      "paper.create": () => {
        throw new Error("Choose an empty folder for the new paper")
      },
    })
    const button = (await screen.findByTestId("paper-create")) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    expect((await screen.findByRole("alert")).textContent).toContain("Choose an empty folder")
    expect(created).toEqual(["start", null])
  })

  test("the card and its button are called Start draft", async () => {
    renderSetup({
      "paper.token.status": () => ({ configured: true, source: "saved" }),
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    const card = await screen.findByTestId("paper-setup-create")
    expect(within(card).getByRole("heading", { level: 3 }).textContent).toBe("Start draft")
    expect(card.textContent).toContain("New paper from template.")
    expect(screen.getByTestId("paper-create").textContent).toBe("Start draft")
    expect(screen.getByTestId("paper-setup").textContent).not.toContain("Create paper")
  })

  test("when paper/ has files in it, Start draft proposes paper-2/ and can start right away", async () => {
    const create = vi.fn(() => ({
      paper: null,
      workspaceId: "new-paper-ws",
      rootRelPath: null,
      autoDetect: true,
    }))
    renderSetup({
      "paper.token.status": () => ({ configured: true, source: "saved" }),
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
      "paper.createTarget": () => ({ dir: "/p/paper-2", displayDir: "paper-2" }),
      "paper.create": create,
    })
    await waitFor(() =>
      expect(screen.getByTestId("paper-create-folder").textContent).toBe("paper-2/"),
    )
    expect(screen.getByTestId("paper-setup").textContent).not.toContain("has files in it")
    const button = screen.getByTestId("paper-create") as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(create).toHaveBeenCalledWith({ projectId: "p1", dir: "/p/paper-2" }))
  })

  test("choosing a folder with files in it says why it cannot be used and keeps the previous folder", async () => {
    const create = vi.fn(() => ({
      paper: null,
      workspaceId: "new-paper-ws",
      rootRelPath: null,
      autoDetect: true,
    }))
    renderSetup({
      "paper.token.status": () => ({ configured: true, source: "saved" }),
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
      "paper.createTarget": () => ({ dir: "/p/paper-2", displayDir: "paper-2" }),
      "paper.canCreateIn": (input) => (input as { dir: string }).dir !== "/Users/me/full",
      "paper.create": create,
      "system.pickDirectory": () => "/Users/me/full",
    })
    await waitFor(() =>
      expect(screen.getByTestId("paper-create-folder").textContent).toBe("paper-2/"),
    )
    fireEvent.click(screen.getByTestId("paper-create-change"))
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That folder already has files. Choose an empty folder, or use 'Use an existing folder' to open it as a paper.",
    )
    expect(screen.getByTestId("paper-create-folder").textContent).toBe("paper-2/")
    fireEvent.click(screen.getByTestId("paper-create"))
    await waitFor(() => expect(create).toHaveBeenCalledWith({ projectId: "p1", dir: "/p/paper-2" }))
  })
})
