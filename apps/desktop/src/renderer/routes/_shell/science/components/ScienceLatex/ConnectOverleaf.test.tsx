import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { ConnectOverleafDialog } from "./ConnectOverleaf"

/**
 * Component tests for the Connect to Overleaf dialog. The tRPC server is a
 * fake (mocked); connecting for real is covered by the `paper` router tests and
 * the e2e test.
 */
function renderDialog(handlers: FakeHandlers, onClose: () => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AppProviders client={createFakeTrpcClient(handlers)} queryClient={queryClient}>
      <ConnectOverleafDialog projectId="p1" onClose={onClose} />
    </AppProviders>,
  )
}

const OVERLEAF_URL = "https://git@git.overleaf.com/6ae5e243374fe1802d83e27a"

/** Type the URL and token and press Connect. */
async function connectWith(token: string): Promise<void> {
  fireEvent.change(await screen.findByTestId("paper-connect-url"), {
    target: { value: OVERLEAF_URL },
  })
  fireEvent.change(await screen.findByTestId("paper-connect-token"), {
    target: { value: token },
  })
  fireEvent.click(screen.getByTestId("paper-connect-submit"))
}

describe("ConnectOverleafDialog (mocked server)", () => {
  test("sends a typed token with the connect (not saved first), and closes when it works", async () => {
    const setToken = vi.fn(() => undefined)
    const connect = vi.fn(() => ({ state: "synced", lastSyncAt: 1 }))
    const onClose = vi.fn()
    renderDialog(
      {
        "paper.token.status": () => ({ configured: false, source: null }),
        "paper.token.set": setToken,
        "paper.connectOverleaf": connect,
      },
      onClose,
    )
    await connectWith("olp_secret")
    await waitFor(() =>
      expect(connect).toHaveBeenCalledWith({
        projectId: "p1",
        url: OVERLEAF_URL,
        token: "olp_secret",
      }),
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(setToken).not.toHaveBeenCalled()
  })

  test("after a failed connect with a typed token, the error and the token field stay", async () => {
    const onClose = vi.fn()
    renderDialog(
      {
        "paper.token.status": () => ({ configured: false, source: null }),
        "paper.connectOverleaf": () => {
          throw new Error("Authentication failed")
        },
      },
      onClose,
    )
    await connectWith("olp_wrong")
    expect((await screen.findByRole("alert")).textContent).toContain("Authentication failed")
    expect(screen.getByTestId("paper-connect-token")).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })
})
