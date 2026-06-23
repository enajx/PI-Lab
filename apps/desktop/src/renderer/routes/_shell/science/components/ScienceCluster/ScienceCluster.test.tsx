import type { Machine } from "@skipper/local-db"
import { QueryClient } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { ScienceCluster } from "./ScienceCluster"

/**
 * Component test for the Cluster science tab (AGENTS.md §14). The tab renders
 * plain DOM + the hand-authored (non-Radix) UI primitives, so jsdom suffices and
 * we assert structure only: machine cards, the hide toggle, the import action,
 * and the empty state — never copy text or shadcn classes.
 */

function renderCluster(handlers: FakeHandlers) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(handlers)
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <ScienceCluster />
    </AppProviders>,
  )
}

function machine(overrides: Partial<Machine> & Pick<Machine, "id" | "host">): Machine {
  return {
    hostname: null,
    user: null,
    port: null,
    source: "ssh-config",
    hidden: false,
    label: null,
    reachable: null,
    lastCheckedAt: null,
    statusDetail: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe("ScienceCluster", () => {
  test("renders a card per machine with its name and status", async () => {
    renderCluster({
      "science.cluster.list": () => ({
        machines: [
          machine({ id: "m1", host: "gpu-box", user: "ada", hostname: "10.0.0.5" }),
          machine({ id: "m2", host: "laptop", reachable: true, lastCheckedAt: 1 }),
        ],
        hiddenCount: 0,
      }),
    })

    await waitFor(() => {
      expect(screen.getAllByTestId("machine-card")).toHaveLength(2)
    })
    const names = screen.getAllByTestId("machine-name").map((el) => el.textContent)
    expect(names).toEqual(["gpu-box", "laptop"])

    // The probed machine reads as reachable; the unprobed one as unknown.
    const statuses = screen.getAllByTestId("machine-status")
    const states = statuses.map((el) => el.getAttribute("data-reachable")).sort()
    expect(states).toEqual(["true", "unknown"])
  })

  test("shows the import action in the header", async () => {
    renderCluster({
      "science.cluster.list": () => ({ machines: [], hiddenCount: 0 }),
    })
    await waitFor(() => {
      expect(screen.getByTestId("import-ssh-config")).toBeTruthy()
    })
  })

  test("renders the 'Show hidden (N)' toggle only when there are hidden machines", async () => {
    renderCluster({
      "science.cluster.list": () => ({
        machines: [machine({ id: "m1", host: "visible-box" })],
        hiddenCount: 2,
      }),
    })

    await waitFor(() => {
      expect(screen.getByTestId("machine-card")).toBeTruthy()
    })
    const toggle = screen.getByTestId("show-hidden")
    expect(toggle.textContent).toContain("2")
  })

  test("hides the 'Show hidden' toggle when nothing is hidden", async () => {
    renderCluster({
      "science.cluster.list": () => ({
        machines: [machine({ id: "m1", host: "box" })],
        hiddenCount: 0,
      }),
    })
    await waitFor(() => {
      expect(screen.getByTestId("machine-card")).toBeTruthy()
    })
    expect(screen.queryByTestId("show-hidden")).toBeNull()
  })

  test("shows the empty state when there are no machines", async () => {
    renderCluster({
      "science.cluster.list": () => ({ machines: [], hiddenCount: 0 }),
    })
    await waitFor(() => {
      expect(screen.getByTestId("science-cluster-empty")).toBeTruthy()
    })
    expect(screen.queryByTestId("machine-card")).toBeNull()
  })

  test("each card exposes hide and annotate affordances", async () => {
    renderCluster({
      "science.cluster.list": () => ({
        machines: [machine({ id: "m1", host: "box" })],
        hiddenCount: 0,
      }),
    })
    await waitFor(() => {
      expect(screen.getByTestId("machine-card")).toBeTruthy()
    })
    expect(screen.getByTestId("toggle-hidden")).toBeTruthy()
    expect(screen.getByTestId("annotate-machine")).toBeTruthy()
  })
})
