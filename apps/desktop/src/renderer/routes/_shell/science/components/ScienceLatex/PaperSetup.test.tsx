import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(handlers)
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <PaperSetup projectId="p1" />
    </AppProviders>,
  )
}

const OVERLEAF_URL = "https://git@git.overleaf.com/6ae5e243374fe1802d83e27a"

describe("PaperSetup (mocked server)", () => {
  test("asks for the Overleaf token when none is saved, then clones", async () => {
    const setToken = vi.fn(() => undefined)
    const addOverleaf = vi.fn(() => undefined)
    renderSetup({
      "paper.token.status": () => ({ configured: false }),
      "paper.token.set": setToken,
      "paper.addOverleaf": addOverleaf,
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    fireEvent.change(screen.getByTestId("paper-overleaf-url"), {
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
      "paper.token.status": () => ({ configured: true }),
      "paper.addOverleaf": addOverleaf,
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    fireEvent.change(screen.getByTestId("paper-overleaf-url"), {
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
      "paper.token.status": () => ({ configured: true }),
      "system.pickDirectory": () => "/Users/me/papers/my-paper",
      "paper.link": link,
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    fireEvent.click(screen.getByTestId("paper-use-folder"))
    await waitFor(() =>
      expect(link).toHaveBeenCalledWith({ projectId: "p1", dir: "/Users/me/papers/my-paper" }),
    )
  })

  test("shows a server error", async () => {
    renderSetup({
      "paper.token.status": () => ({ configured: true }),
      "paper.addOverleaf": () => {
        throw new Error("paper/ already exists in this project")
      },
      "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
    })
    fireEvent.change(screen.getByTestId("paper-overleaf-url"), {
      target: { value: OVERLEAF_URL },
    })
    await waitFor(() =>
      expect((screen.getByTestId("paper-overleaf-add") as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId("paper-overleaf-add"))
    expect((await screen.findByRole("alert")).textContent).toContain("already exists")
  })
})
