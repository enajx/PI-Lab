import { QueryClient } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient } from "../../../../../test/fakeTrpcClient"

/**
 * Component test for the LaTeX Editor project picker. The tRPC server and the
 * router are fakes (mocked); the e2e test covers the real app.
 */
const mocks = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }))

const { ScienceLatex } = await import("./ScienceLatex")

beforeEach(() => {
  window.localStorage.clear()
  mocks.navigate.mockReset()
})
afterEach(() => cleanup())

test("after arriving with a project in the address, the picker still switches project and is remembered", async () => {
  const client = createFakeTrpcClient({
    "projects.list": () => [
      { id: "p1", name: "One" },
      { id: "p2", name: "Two" },
    ],
    "settings.get": () => ({}),
    "paper.get": () => ({ paper: null, workspaceId: null, rootRelPath: null }),
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <ScienceLatex
        initialProjectId="p1"
        focusSession={{ sessionId: "s1", agentId: "codex", agentLabel: "Codex" }}
      />
    </AppProviders>,
  )
  const select = (await screen.findByTestId("latex-project-select")) as HTMLSelectElement
  await waitFor(() => expect(select.value).toBe("p1"))
  fireEvent.change(select, { target: { value: "p2" } })
  // The address switches to the chosen project and drops the agent to focus.
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/science/latex",
    search: { projectId: "p2" },
    replace: true,
  })
  expect(window.localStorage.getItem("pi-lab.latexEditor.project")).toContain("p2")
})
