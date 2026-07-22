import type { Project, ProjectMetadata } from "@pi-lab/local-db"
import { QueryClient } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { describe, expect, test } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
// StrictMode-wrapped render (see test/render.tsx): reproduces the dev build's
// effect double-invoke so mount effects run as they do in the app.
import { fireEvent, render, screen, waitFor, within } from "../../../../../test/render"
import { readPendingLaunch } from "../../../projects/-pendingLaunch"
import { ProjectCard } from "./ProjectCard"

/**
 * Component test for a single project card: its extra metadata (plan "Edit
 * project…"), the auto-research launch intent, and the two stateful background
 * workflow controls ("Fetch remote experiments" / "Project summary"), which run
 * headlessly, cache per git-state, and open a result popup when done. Mounts the
 * real card under providers + a router (so `useNavigate` resolves) with a faked
 * tRPC client — jsdom suffices.
 */

function project(overrides: Partial<Project> & Pick<Project, "id" | "name">): Project {
  return {
    repoPath: `/tmp/${overrides.id}`,
    defaultBranch: "main",
    color: null,
    thumbnail: null,
    // A stored gradient so the card doesn't try to persist a default on first render.
    gradient: { seed: 1, palette: ["#FFC700"] },
    metadata: null,
    agentConfig: null,
    sortIndex: 0,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    lastOpenedAt: 0,
    ...overrides,
  }
}

/** A "no runs yet" workflow status — both controls render idle. */
const IDLE_STATUS = { summary: null, fetchExperiments: null }

function renderCard(p: Project, handlers: FakeHandlers = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient({
    "sessions.activity": () => [],
    "workflows.status": () => IDLE_STATUS,
    ...handlers,
  })

  const rootRoute = createRootRoute({ component: Outlet })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <ProjectCard project={p} />,
  })
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$projectId",
    component: function ProjectRouteMarker() {
      const { projectId } = projectRoute.useParams()
      return <div data-testid="on-project-route" data-project-id={projectId} />
    },
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, projectRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })

  return render(
    <AppProviders client={client} queryClient={queryClient}>
      {/* biome-ignore lint/suspicious/noExplicitAny: test router type plumbing. */}
      <RouterProvider router={router as any} />
    </AppProviders>,
  )
}

const FULL_METADATA: ProjectMetadata = {
  collaborators: "Ada Lovelace, Alan Turing",
  venue: "NeurIPS 2026",
  deadline: "2026-11-30",
  emojiTags: ["🔬", "🚀"],
  referenceLinks: [
    { url: "https://example.com/paper", label: "Preprint" },
    { url: "https://example.com/code" },
  ],
}

describe("ProjectCard metadata", () => {
  test("renders every filled field under the title, below the image", async () => {
    renderCard(project({ id: "p1", name: "Alpha", metadata: FULL_METADATA }))

    const block = await screen.findByTestId("project-card-metadata")

    // Positioned after the header image within the card (i.e. below the thumbnail).
    const image = screen.getByTestId("project-card-image")
    expect(image.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    expect(within(block).getByTestId("project-card-collaborators").textContent).toContain(
      "Ada Lovelace, Alan Turing",
    )
    expect(within(block).getByTestId("project-card-venue").textContent).toContain("NeurIPS 2026")
    // Deadline is formatted from the ISO date; assert locale-robustly.
    const deadline = within(block).getByTestId("project-card-deadline").textContent ?? ""
    expect(deadline).toContain("Due")
    expect(deadline).toContain("2026")

    expect(within(block).getAllByTestId("project-card-emoji-tag")).toHaveLength(2)

    const [preprint, code] = within(block).getAllByTestId("project-card-link")
    expect(preprint?.textContent).toContain("example")
    expect(preprint?.getAttribute("href")).toBe("https://example.com/paper")
    expect(code?.textContent).toContain("example")
    expect(code?.getAttribute("href")).toBe("https://example.com/code")
  })

  test("all three action buttons render, are compact (icon-only), and share one row", async () => {
    renderCard(project({ id: "pbtn", name: "Kappa", metadata: null }))

    const auto = await screen.findByTestId("project-card-auto-research")
    const fetch = screen.getByTestId("project-card-fetch-experiments")
    const summary = screen.getByTestId("project-card-summary")

    // Icon-forward: no wrapping text labels, so the three fit on one row. Each still
    // carries an accessible name and the hover-help attributes for discoverability.
    for (const button of [auto, fetch, summary]) {
      expect(button.textContent?.trim()).toBe("")
      expect(button.getAttribute("aria-label")).toBeTruthy()
      expect(button.getAttribute("data-feature-help")).toBeTruthy()
    }
    expect(auto.getAttribute("aria-label")).toContain("Auto-research")
    expect(fetch.getAttribute("aria-label")).toContain("Fetch experiments")
    expect(summary.getAttribute("aria-label")).toContain("Project summary")

    // The three action buttons live in one shared footer row.
    expect(auto.parentElement).toBe(fetch.parentElement)
    expect(fetch.parentElement).toBe(summary.parentElement)
  })

  test("renders nothing for empty fields (only the filled one shows)", async () => {
    renderCard(project({ id: "p2", name: "Beta", metadata: { venue: "ICML 2026" } }))

    const block = await screen.findByTestId("project-card-metadata")
    expect(within(block).getByTestId("project-card-venue").textContent).toContain("ICML 2026")
    expect(within(block).queryByTestId("project-card-collaborators")).toBeNull()
    expect(within(block).queryByTestId("project-card-deadline")).toBeNull()
    expect(within(block).queryByTestId("project-card-emoji-tags")).toBeNull()
    expect(within(block).queryByTestId("project-card-links")).toBeNull()
  })

  test("shows no metadata block when the project has none", async () => {
    renderCard(project({ id: "p3", name: "Gamma", metadata: null }))
    await screen.findByTestId("project-card")
    expect(screen.queryByTestId("project-card-metadata")).toBeNull()
  })

  test("Auto-research opens the project immediately, without awaiting a launch RPC", async () => {
    const calls: unknown[] = []
    renderCard(project({ id: "p5", name: "Epsilon", metadata: null }), {
      "sessions.startAutoResearch": (input) => {
        calls.push(input)
        return new Promise(() => {})
      },
    })

    const button = await screen.findByTestId("project-card-auto-research")
    fireEvent.click(button)

    const marker = await screen.findByTestId("on-project-route")
    expect(marker.getAttribute("data-project-id")).toBe("p5")
    expect(readPendingLaunch("p5")).toEqual({ kind: "auto-research" })
    expect(calls).toHaveLength(0)
  })

  test("Edit project… opens the dialog and saves via setMetadata", async () => {
    const calls: unknown[] = []
    renderCard(project({ id: "p4", name: "Delta", metadata: null }), {
      "projects.setMetadata": (input) => {
        calls.push(input)
        return project({ id: "p4", name: "Delta" })
      },
    })

    fireEvent.contextMenu(await screen.findByTestId("project-card-image"))
    fireEvent.click(screen.getByTestId("project-card-menu-edit"))

    const dialog = screen.getByTestId("edit-project-dialog")
    fireEvent.change(within(dialog).getByTestId("edit-project-collaborators"), {
      target: { value: "Grace Hopper" },
    })
    fireEvent.click(within(dialog).getByTestId("edit-project-save"))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ id: "p4", metadata: { collaborators: "Grace Hopper" } })
  })
})

describe("ProjectCard background workflow controls", () => {
  test("an idle control triggers a background run on click (no navigation)", async () => {
    const calls: unknown[] = []
    renderCard(project({ id: "wf-idle", name: "Photon", metadata: null }), {
      "workflows.run": (input) => {
        calls.push(input)
        return {
          cached: false,
          running: false,
          result: "done",
          inputHash: "h",
          lastCheckedAt: Date.now(),
          errorMessage: null,
        }
      },
    })

    const summary = await screen.findByTestId("project-card-summary")
    expect(summary.getAttribute("data-state")).toBe("idle")

    fireEvent.click(summary)

    // The idle click starts a run for this (project, task); it does NOT navigate.
    await waitFor(() => expect(calls).toEqual([{ projectId: "wf-idle", task: "summary" }]))
    expect(screen.queryByTestId("on-project-route")).toBeNull()
  })

  test("a running control shows the loading dots and opens the live log window on click", async () => {
    renderCard(project({ id: "wf-run", name: "Photon", metadata: null }), {
      "workflows.status": () => ({
        summary: {
          running: true,
          result: "",
          inputHash: "",
          lastCheckedAt: 0,
          errorMessage: null,
        },
        fetchExperiments: null,
      }),
      // The window subscribes to the run's live output; emit a streamed line.
      "workflows.onOutput": () => ({ kind: "chunk", stream: "stdout", text: "Reviewing commits…" }),
    })

    const summary = await screen.findByTestId("project-card-summary")
    await waitFor(() => expect(summary.getAttribute("data-state")).toBe("running"))
    // A running control shows the orange snake edge (the "thinking" animation).
    expect(summary.querySelector(".pi-lab-workflow-snake")).toBeTruthy()
    // A running control is clickable (not disabled) so the user can watch it work.
    expect((summary as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(summary)

    const dialog = await screen.findByTestId("workflow-result-dialog")
    // The live activity log shows the streamed output, and the report is "working…".
    await waitFor(() =>
      expect(within(dialog).getByTestId("workflow-activity-log").textContent).toContain(
        "Reviewing commits…",
      ),
    )
    expect(within(dialog).getByTestId("workflow-result-working")).toBeTruthy()
    expect(within(dialog).queryByTestId("workflow-result-text")).toBeNull()
  })

  test("a done control is neutral (no green) and opens the result popup (result + last-checked) on click", async () => {
    const calls: unknown[] = []
    renderCard(project({ id: "wf-done", name: "Photon", metadata: null }), {
      "workflows.status": () => ({
        summary: {
          running: false,
          result: "Eta is progressing nicely.",
          inputHash: "h",
          lastCheckedAt: Date.now() - 90_000,
          errorMessage: null,
        },
        fetchExperiments: null,
      }),
      "workflows.run": (input) => {
        calls.push(input)
        return {
          cached: true,
          running: false,
          result: "Eta is progressing nicely.",
          inputHash: "h",
          lastCheckedAt: Date.now(),
          errorMessage: null,
        }
      },
    })

    const summary = await screen.findByTestId("project-card-summary")
    await waitFor(() => expect(summary.getAttribute("data-state")).toBe("done"))
    // A done control is neutral — no green tint (the result lives in the window).
    expect(summary.className).not.toContain("emerald")

    fireEvent.click(summary)

    const dialog = await screen.findByTestId("workflow-result-dialog")
    expect(within(dialog).getByTestId("workflow-result-text").textContent).toContain(
      "Eta is progressing nicely.",
    )
    expect(within(dialog).getByTestId("workflow-result-last-checked").textContent).toContain(
      "Last checked:",
    )
    expect(within(dialog).getByTestId("workflow-result-guidance").textContent).toContain(
      "RESEARCH.md",
    )
    // Clicking a done control also re-checks (the run returns the cache).
    await waitFor(() => expect(calls).toEqual([{ projectId: "wf-done", task: "summary" }]))

    fireEvent.click(within(dialog).getByTestId("workflow-result-close"))
    await waitFor(() => expect(screen.queryByTestId("workflow-result-dialog")).toBeNull())
  })

  test("an errored control is red and opens the popup showing the failure", async () => {
    renderCard(project({ id: "wf-err", name: "Photon", metadata: null }), {
      "workflows.status": () => ({
        summary: {
          running: false,
          result: "",
          inputHash: "h",
          lastCheckedAt: Date.now(),
          errorMessage: "Claude Code is not available",
        },
        fetchExperiments: null,
      }),
      "workflows.run": () => ({
        cached: false,
        running: false,
        result: "",
        inputHash: "h",
        lastCheckedAt: Date.now(),
        errorMessage: "Claude Code is not available",
      }),
    })

    const summary = await screen.findByTestId("project-card-summary")
    await waitFor(() => expect(summary.getAttribute("data-state")).toBe("error"))
    expect(summary.className).toContain("red")

    fireEvent.click(summary)

    const dialog = await screen.findByTestId("workflow-result-dialog")
    expect(within(dialog).getByTestId("workflow-result-error").textContent).toContain(
      "Claude Code is not available",
    )
    expect(within(dialog).queryByTestId("workflow-result-text")).toBeNull()
  })

  test("the fetch-experiments control passes its Settings instructions to the run", async () => {
    const calls: Array<Record<string, unknown>> = []
    renderCard(project({ id: "wf-fetch", name: "Photon", metadata: null }), {
      "workflows.run": (input) => {
        calls.push(input as Record<string, unknown>)
        return {
          cached: false,
          running: false,
          result: "fetched",
          inputHash: "h",
          lastCheckedAt: Date.now(),
          errorMessage: null,
        }
      },
    })

    fireEvent.click(await screen.findByTestId("project-card-fetch-experiments"))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]?.projectId).toBe("wf-fetch")
    expect(calls[0]?.task).toBe("fetch-experiments")
    // Instructions are read from Settings (empty by default) and always passed.
    expect(calls[0]).toHaveProperty("instructions")
  })

  test("an idle control opens the result window on the FIRST click", async () => {
    renderCard(project({ id: "wf-first", name: "Photon", metadata: null }), {
      "workflows.run": () => ({
        cached: false,
        running: true,
        result: "",
        inputHash: "h",
        lastCheckedAt: 0,
        errorMessage: null,
      }),
      "workflows.onOutput": () => ({ kind: "start", command: "Claude Code · /usr/bin/claude" }),
    })

    const summary = await screen.findByTestId("project-card-summary")
    expect(summary.getAttribute("data-state")).toBe("idle")

    // A single click both starts the run AND opens the window (no second click).
    fireEvent.click(summary)
    expect(await screen.findByTestId("workflow-result-dialog")).toBeTruthy()
  })

  test("the window's Recheck button forces a fresh run", async () => {
    const calls: Array<Record<string, unknown>> = []
    renderCard(project({ id: "wf-recheck", name: "Photon", metadata: null }), {
      "workflows.status": () => ({
        summary: {
          running: false,
          result: "Steady progress.",
          inputHash: "h",
          lastCheckedAt: Date.now() - 5_000,
          errorMessage: null,
        },
        fetchExperiments: null,
      }),
      "workflows.run": (input) => {
        calls.push(input as Record<string, unknown>)
        return {
          cached: false,
          running: true,
          result: "Steady progress.",
          inputHash: "h",
          lastCheckedAt: Date.now(),
          errorMessage: null,
        }
      },
      "workflows.onOutput": () => ({ kind: "start", command: "Claude" }),
    })

    const summary = await screen.findByTestId("project-card-summary")
    await waitFor(() => expect(summary.getAttribute("data-state")).toBe("done"))

    fireEvent.click(summary)
    const dialog = await screen.findByTestId("workflow-result-dialog")
    const recheck = within(dialog).getByTestId("workflow-result-recheck")
    await waitFor(() => expect((recheck as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(recheck)
    // Recheck re-runs with force:true (bypassing the git-state cache).
    await waitFor(() => expect(calls.some((call) => call.force === true)).toBe(true))
  })
})
