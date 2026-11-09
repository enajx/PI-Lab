import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { PaperSetup } from "./PaperSetup"

/**
 * Component tests for linking a paper to a project. The tRPC server is a fake
 * (mocked); cloning and linking for real are covered by the `paper` router tests
 * and the e2e test.
 */
function renderSetup(handlers: FakeHandlers) {
  return renderSetupWith(handlers, true)
}

/** {@link renderSetup} with auto-detection on or off (off after the user cleared the folder). */
function renderSetupWith(handlers: FakeHandlers, autoDetect: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient({
    "paper.detect": () => ({ clones: [], stoppedEarly: false }),
    ...handlers,
  })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <PaperSetup projectId="p1" autoDetect={autoDetect} />
    </AppProviders>,
  )
}

const OVERLEAF_URL = "https://git@git.overleaf.com/6ae5e243374fe1802d83e27a"

describe("PaperSetup (mocked server)", () => {
  test("asks for the Overleaf token when none is saved, then clones", async () => {
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
      expect(addOverleaf).toHaveBeenCalledWith({ projectId: "p1", url: OVERLEAF_URL }),
    )
    expect(setToken).toHaveBeenCalledWith({ token: "olp_secret" })
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
      "paper.checkFolder": () => ({ projectFolder: false, overleaf: false, remoteUrl: null }),
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
      "paper.checkFolder": () => ({ projectFolder: true, overleaf: false, remoteUrl: null }),
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

  test("the pair of cards is centred on the page and each card centres its content vertically", async () => {
    renderSetup({
      "paper.token.status": () => ({ configured: false, source: null }),
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    // The page fills the area below the top bar and scrolls when it is too short.
    await screen.findByTestId("paper-setup-overleaf")
    const page = screen.getByTestId("paper-setup")
    expect(page.className).toContain("flex-1")
    expect(page.className).toContain("overflow-y-auto")
    // Auto margins centre the content both ways without clipping it when it overflows.
    const content = screen.getByTestId("paper-setup-content")
    expect(content.parentElement).toBe(page)
    expect(content.className).toContain("m-auto")
    // Grid items stretch, so both cards have the same height.
    const grid = screen.getByTestId("paper-setup-overleaf").parentElement as HTMLElement
    expect(grid.className).toContain("grid")
    expect(grid.className).not.toMatch(/items-(start|center|end)/)
    for (const card of [
      screen.getByTestId("paper-setup-overleaf"),
      screen.getByTestId("paper-setup-folder"),
    ]) {
      expect(card.className).toContain("justify-center")
    }
  })

  test("both cards centre their content and keep the text short", async () => {
    renderSetup({
      "paper.token.status": () => ({ configured: false, source: null }),
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    const overleaf = await screen.findByTestId("paper-setup-overleaf")
    const folder = screen.getByTestId("paper-setup-folder")
    for (const card of [overleaf, folder]) {
      expect(card.className).toContain("items-center")
      expect(card.className).toContain("text-center")
    }
    expect(overleaf.textContent).toContain("Clone your Overleaf project into paper/.")
    expect(folder.textContent).toContain("Open a paper folder you already cloned.")
    expect(folder.textContent).not.toContain("outside this project")
    await screen.findByTestId("paper-overleaf-token")
    expect(overleaf.textContent).not.toContain("keychain")
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
      expect(addOverleaf).toHaveBeenCalledWith({ projectId: "p1", url: OVERLEAF_URL }),
    )
  })
})
