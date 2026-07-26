import type { Machine } from "@pi-lab/local-db"
import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, test } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { ScienceCluster } from "./ScienceCluster"

/**
 * Component test for the Cluster science tab (md/engineering/testing-and-build.md). The tab renders
 * plain DOM + the hand-authored (non-Radix) UI primitives, so jsdom suffices and
 * we assert structure only: machine cards, the hide toggle, the import action,
 * and the empty state — never copy text or shadcn classes.
 */

function renderCluster(handlers: FakeHandlers) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const client = createFakeTrpcClient(handlers)
  const result = render(
    <AppProviders client={client} queryClient={queryClient}>
      <ScienceCluster />
    </AppProviders>,
  )
  return { ...result, queryClient }
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
  // The card order + independent spans live in localStorage; reset between tests
  // so persisted layout never leaks into the next case.
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
    expect(statuses[0]?.textContent).toContain("not checked")
    expect(screen.getByText("online")).toBeTruthy()
    expect(screen.getAllByTestId("machine-running-projects")).toHaveLength(2)
    expect(screen.queryByText("ssh config")).toBeNull()
    const caffeine = screen.getByTestId("caffeine-control")
    expect(caffeine.parentElement?.lastElementChild).toBe(caffeine)
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
    expect(screen.getByTestId("cluster-grid").hidden).toBe(true)
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
    expect(screen.getByTestId("machine-checked-at").textContent).toContain("Checked")
    expect(screen.getAllByTestId("gpu-row")[0]?.className).toContain("grid-cols")
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

  test("Tab cycles the machine finder between Cluster and all projects", async () => {
    renderCluster({
      "science.cluster.list": () => ({
        machines: [machine({ id: "m1", host: "alpha" })],
        hiddenCount: 0,
      }),
      "projects.list": () => [{ id: "p1", name: "Research", repoPath: "/tmp/research" }],
    })
    await screen.findByTestId("machine-card")

    fireEvent.keyDown(window, { key: "f", metaKey: true })
    const input = await screen.findByTestId("quick-find-input")
    expect(screen.getByTestId("quick-find-scope").textContent).toContain("Cluster machines")

    fireEvent.keyDown(input, { key: "Tab" })
    await waitFor(() =>
      expect(screen.getByTestId("quick-find-scope").textContent).toContain("All projects"),
    )
    expect(screen.getByTestId("quick-find-item").getAttribute("data-find-id")).toBe("p1")
  })

  test("removes the scalar card-size slider", async () => {
    renderCluster({
      "science.cluster.list": () => ({
        machines: [machine({ id: "m1", host: "box" })],
        hiddenCount: 0,
      }),
    })

    await screen.findByTestId("machine-card")
    expect(screen.queryByTestId("cluster-card-size")).toBeNull()
    expect(screen.getByTestId("cluster-grid").getAttribute("data-card-grid-base-column")).toBe(
      "280",
    )
    expect(screen.getByTestId("machine-card-drag").getAttribute("data-card-span")).toBe("1x1")
    expect(screen.getByTestId("card-resize-handle")).toBeTruthy()
  })

  test("the resize handle cannot start machine-card reordering", async () => {
    renderCluster({
      "science.cluster.list": () => ({
        machines: [machine({ id: "m1", host: "alpha" }), machine({ id: "m2", host: "beta" })],
        hiddenCount: 0,
      }),
    })

    await screen.findAllByTestId("machine-card")
    const handle = screen.getAllByTestId("card-resize-handle")[1]
    if (!handle) throw new Error("Expected the second machine resize handle")
    const alpha = screen
      .getAllByTestId("machine-card")
      .find((card) => card.getAttribute("data-host") === "alpha")
    fireEvent.dragStart(handle)
    if (alpha) {
      fireEvent.dragOver(alpha)
      fireEvent.drop(alpha)
    }

    expect(screen.getAllByTestId("machine-name").map((element) => element.textContent)).toEqual([
      "alpha",
      "beta",
    ])
  })

  test("hiding ignores legacy machine spans because Cluster now uses one shared scale", async () => {
    let machines = [machine({ id: "m1", host: "alpha" })]
    window.localStorage.setItem("pi-lab.cardGrid.cluster.spans", JSON.stringify({ m1: "2x2" }))
    const { queryClient } = renderCluster({
      "science.cluster.list": (input) => {
        const includeHidden = (input as { includeHidden: boolean }).includeHidden
        return {
          machines: includeHidden ? machines : machines.filter((item) => !item.hidden),
          hiddenCount: machines.filter((item) => item.hidden).length,
        }
      },
      "science.cluster.setHidden": (input) => {
        const { id, hidden } = input as { id: string; hidden: boolean }
        machines = machines.map((item) => (item.id === id ? { ...item, hidden } : item))
        return machines[0]
      },
    })

    expect((await screen.findByTestId("machine-card-drag")).dataset.cardSpan).toBe("1x1")
    expect(window.localStorage.getItem("pi-lab.cardGrid.cluster.spans")).toBeNull()
    fireEvent.click(screen.getByTestId("toggle-hidden"))
    await screen.findByTestId("science-cluster-empty")

    fireEvent.click(screen.getByTestId("show-hidden"))
    expect((await screen.findByTestId("machine-card-drag")).dataset.cardSpan).toBe("1x1")

    machines = []
    await queryClient.invalidateQueries()
    await screen.findByTestId("science-cluster-empty")
    expect(screen.getByTestId("cluster-grid").hidden).toBe(true)
    expect(window.localStorage.getItem("pi-lab.cardGrid.cluster.spans")).toBeNull()
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
    expect(screen.getByTestId("machine-status").textContent).toContain("offline")
    // …while the full detail lives in a hover-gated popover (in the DOM, hidden by default).
    const detail = screen.getByTestId("machine-status-detail")
    expect(detail.textContent).toContain("Connection refused")
    expect(detail.className).toContain("group-hover/err:block")
  })
})
