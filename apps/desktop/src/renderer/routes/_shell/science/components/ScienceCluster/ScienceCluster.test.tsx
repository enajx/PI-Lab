import type { Machine } from "@skipper/local-db"
import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, test } from "vitest"
import {
  CLUSTER_CARD_MAX_SIZE,
  CLUSTER_CARD_MIN_SIZE,
} from "../../../../../preferences/preferences"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { ScienceCluster } from "./ScienceCluster"

/**
 * Component test for the Cluster science tab (docs/testing-and-build.md). The tab renders
 * plain DOM + the hand-authored (non-Radix) UI primitives, so jsdom suffices and
 * we assert structure only: machine cards, the hide toggle, the import action,
 * and the empty state — never copy text or shadcn classes.
 */

function renderCluster(handlers: FakeHandlers) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
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
  // The card order + card-size live in localStorage; reset between tests so a
  // persisted drag order or slider value never leaks into the next case.
  beforeEach(() => {
    window.localStorage.clear()
  })

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

  test("a Check probe renders the returned GPU rows, busy summary, and CPU usage", async () => {
    const reachable = machine({ id: "m1", host: "gpu-box", reachable: true, lastCheckedAt: 1 })
    renderCluster({
      "science.cluster.list": () => ({ machines: [reachable], hiddenCount: 0 }),
      "science.cluster.refreshStatus": () => ({
        machine: reachable,
        gpus: [
          { index: 0, name: "A100", utilization: 4, memUsed: 500, memTotal: 81920 },
          { index: 1, name: "A100", utilization: 88, memUsed: 70000, memTotal: 81920 },
        ],
        cpuUsage: 37,
      }),
    })

    await waitFor(() => {
      expect(screen.getByTestId("machine-card")).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId("refresh-machine"))

    await waitFor(() => {
      expect(screen.getByTestId("machine-telemetry")).toBeTruthy()
    })
    expect(screen.getAllByTestId("gpu-row")).toHaveLength(2)
    // One GPU over the busy threshold ⇒ "1/2 GPUs busy".
    expect(screen.getByTestId("gpu-summary").textContent).toContain("1/2")
    expect(screen.getByTestId("cpu-usage").textContent).toContain("37")
  })

  test("a reachable host with no GPUs renders the no-GPUs fallback", async () => {
    const reachable = machine({ id: "m1", host: "cpu-only", reachable: true, lastCheckedAt: 1 })
    renderCluster({
      "science.cluster.list": () => ({ machines: [reachable], hiddenCount: 0 }),
      "science.cluster.refreshStatus": () => ({ machine: reachable, gpus: [] }),
    })

    await waitFor(() => {
      expect(screen.getByTestId("machine-card")).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId("refresh-machine"))

    await waitFor(() => {
      expect(screen.getByTestId("gpu-summary").textContent).toContain("No GPUs")
    })
    expect(screen.queryByTestId("gpu-row")).toBeNull()
  })

  test("orders cards alphabetically by display name (label or host) by default", async () => {
    renderCluster({
      "science.cluster.list": () => ({
        machines: [
          machine({ id: "m1", host: "zeta" }),
          machine({ id: "m2", host: "alpha" }),
          machine({ id: "m3", host: "delta", label: "  Mango " }),
        ],
        hiddenCount: 0,
      }),
    })

    await waitFor(() => {
      expect(screen.getAllByTestId("machine-card")).toHaveLength(3)
    })
    const names = screen.getAllByTestId("machine-name").map((el) => el.textContent)
    expect(names).toEqual(["alpha", "Mango", "zeta"])
  })

  test("drag-reordering a card moves it to the drop target's slot", async () => {
    renderCluster({
      "science.cluster.list": () => ({
        machines: [
          machine({ id: "m1", host: "alpha" }),
          machine({ id: "m2", host: "beta" }),
          machine({ id: "m3", host: "gamma" }),
        ],
        hiddenCount: 0,
      }),
    })

    await waitFor(() => {
      expect(screen.getAllByTestId("machine-card")).toHaveLength(3)
    })
    const cardByHost = (host: string) =>
      // biome-ignore lint/style/noNonNullAssertion: the host is seeded above.
      screen.getAllByTestId("machine-card").find((el) => el.getAttribute("data-host") === host)!

    fireEvent.dragStart(cardByHost("gamma"))
    fireEvent.dragOver(cardByHost("alpha"))
    fireEvent.drop(cardByHost("alpha"))

    await waitFor(() => {
      const names = screen.getAllByTestId("machine-name").map((el) => el.textContent)
      expect(names).toEqual(["gamma", "alpha", "beta"])
    })
  })

  test("the quick-open shortcut opens a machine finder that focuses the picked card", async () => {
    renderCluster({
      "science.cluster.list": () => ({
        machines: [
          machine({ id: "m1", host: "alpha" }),
          machine({ id: "m2", host: "beta", label: "Training box" }),
        ],
        hiddenCount: 0,
      }),
    })

    await waitFor(() => {
      expect(screen.getAllByTestId("machine-card")).toHaveLength(2)
    })

    // ⌘F opens the finder over the machines (not projects).
    fireEvent.keyDown(window, { key: "f", metaKey: true })
    const input = await screen.findByTestId("quick-find-input")

    // Fuzzy-filtering by name narrows to the one machine and selecting it closes the finder…
    fireEvent.change(input, { target: { value: "Training" } })
    expect(screen.getAllByTestId("quick-find-item")).toHaveLength(1)
    const row = screen.getByTestId("quick-find-item")
    expect(row.getAttribute("data-find-id")).toBe("m2")
    fireEvent.click(row)

    await waitFor(() => {
      expect(screen.queryByTestId("quick-find")).toBeNull()
    })

    // …and the chosen machine's card wrapper is focused (the transient ring marker).
    const focused = document.querySelector('[data-machine-id="m2"]')
    expect(focused?.getAttribute("data-focused")).toBe("true")
  })

  test("the card-size slider drives the grid's column template", async () => {
    renderCluster({
      "science.cluster.list": () => ({
        machines: [machine({ id: "m1", host: "box" })],
        hiddenCount: 0,
      }),
    })

    await waitFor(() => {
      expect(screen.getByTestId("cluster-card-size")).toBeTruthy()
    })
    const slider = screen.getByTestId("cluster-card-size") as HTMLInputElement
    expect(slider.min).toBe(String(CLUSTER_CARD_MIN_SIZE))
    expect(slider.max).toBe(String(CLUSTER_CARD_MAX_SIZE))

    fireEvent.change(slider, { target: { value: "500" } })
    await waitFor(() => {
      expect(screen.getByTestId("cluster-grid").style.gridTemplateColumns).toContain("500px")
    })
  })

  test("an unreachable host reveals its error in a hover popover, not inline", async () => {
    renderCluster({
      "science.cluster.list": () => ({
        machines: [
          machine({
            id: "m1",
            host: "down-box",
            reachable: false,
            lastCheckedAt: 1,
            statusDetail: "ssh: connect to host down-box port 22: Connection refused",
          }),
        ],
        hiddenCount: 0,
      }),
    })

    await waitFor(() => {
      expect(screen.getByTestId("machine-card")).toBeTruthy()
    })
    // The status label stays always-visible…
    expect(screen.getByTestId("machine-status").getAttribute("data-reachable")).toBe("false")
    // …while the full detail lives in a hover-gated popover (in the DOM, hidden by default).
    const detail = screen.getByTestId("machine-status-detail")
    expect(detail.textContent).toContain("Connection refused")
    expect(detail.className).toContain("group-hover/err:block")
  })
})
