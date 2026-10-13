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
import { describe, expect, test, vi } from "vitest"
import { setInterfaceLanguage } from "../../../../../i18n/language"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
// StrictMode-wrapped render (see test/render.tsx): reproduces the dev build's
// effect double-invoke so mount effects run as they do in the app.
import { act, fireEvent, render, screen, waitFor, within } from "../../../../../test/render"
import { ProjectActivityProvider } from "../../../-ProjectActivity"
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
    digitalRain: false,
    // A stored gradient so the card doesn't try to persist a default on first render.
    gradient: { seed: 1, palette: ["#FFC700"] },
    metadata: null,
    taskRelPath: null,
    mainRelPath: null,
    typeId: "general",
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
  const { thumbnail, ...fields } = p
  const summary = { ...fields, hasThumbnail: thumbnail !== null }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient({
    "sessions.activity": () => [],
    "projects.capabilities": () => ({ git: true }),
    "workflows.status": () => IDLE_STATUS,
    "projects.thumbnail": () => ({ dataUrl: thumbnail, tooLarge: false }),
    ...handlers,
  })

  const rootRoute = createRootRoute({ component: Outlet })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <ProjectCard project={summary} />,
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
      <ProjectActivityProvider>
        {/* biome-ignore lint/suspicious/noExplicitAny: test router type plumbing. */}
        <RouterProvider router={router as any} />
      </ProjectActivityProvider>
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

describe("ProjectCard thumbnail", () => {
  test("shows an untyped project choice on the card without opening the workspace", async () => {
    const choices: unknown[] = []
    renderCard(project({ id: "p1", name: "Untyped", typeId: "general" }), {
      "settings.get": () => ({
        projectTemplate: {
          projectTypes: [
            { id: "research", name: "Research project", guidance: "" },
            { id: "software", name: "Software project", guidance: "" },
            { id: "paper", name: "Paper", guidance: "" },
          ],
        },
      }),
      "projects.setType": (input) => {
        choices.push(input)
      },
    })

    const select = (await screen.findByTestId("project-card-type-p1")) as HTMLSelectElement
    expect(select.value).toBe("")
    fireEvent.click(select)
    fireEvent.change(select, { target: { value: "software" } })
    await waitFor(() => expect(choices).toEqual([{ id: "p1", typeId: "software" }]))
    expect(screen.queryByTestId("on-project-route")).toBeNull()
  })

  test("loads the card artwork variant separately from the project summary", async () => {
    const requests: unknown[] = []
    renderCard(project({ id: "p1", name: "Picture", thumbnail: "data:image/gif;base64,AAAA" }), {
      "projects.thumbnail": (input) => {
        requests.push(input)
        return { dataUrl: "data:image/gif;base64,AAAA", tooLarge: false }
      },
    })
    await waitFor(() => {
      expect(
        screen.getByTestId("project-card-image").querySelector("img")?.getAttribute("src"),
      ).toBe("data:image/gif;base64,AAAA")
    })
    expect(requests).toEqual([{ id: "p1", variant: "card" }])
  })

  test("a slow image read cannot replace a later gradient choice", async () => {
    let pendingReader: { onload: (() => void) | null } | null = null
    class SlowFileReader {
      result = "data:image/gif;base64,AAAA"
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      onabort: (() => void) | null = null
      readAsDataURL() {
        pendingReader = this
      }
    }
    vi.stubGlobal("FileReader", SlowFileReader)
    const thumbnails: unknown[] = []
    const gradients: unknown[] = []
    renderCard(project({ id: "p1", name: "Picture" }), {
      "projects.setThumbnail": (input) => {
        thumbnails.push(input)
        return project({ id: "p1", name: "Picture" })
      },
      "projects.setGradient": (input) => {
        gradients.push(input)
        return project({ id: "p1", name: "Picture" })
      },
    })
    fireEvent.change(await screen.findByTestId("project-card-thumbnail-input"), {
      target: { files: [new File(["GIF89a"], "slow.gif", { type: "image/gif" })] },
    })
    await waitFor(() => expect(pendingReader).not.toBeNull())
    fireEvent.contextMenu(screen.getByTestId("project-card"))
    fireEvent.click(screen.getByTestId("project-card-menu-thumbnail"))
    fireEvent.click(screen.getByTestId("project-card-artwork-gradient"))
    await waitFor(() => expect(gradients).toHaveLength(1))
    ;(pendingReader as SlowFileReader | null)?.onload?.()
    await Promise.resolve()
    expect(thumbnails).toHaveLength(0)
    vi.unstubAllGlobals()
  })
})

describe("ProjectCard metadata", () => {
  test("translates the card status and artwork chooser when language changes", async () => {
    renderCard(project({ id: "translated", name: "Study" }))
    act(() => setInterfaceLanguage("es"))
    expect((await screen.findByTestId("project-card-status")).textContent).toContain(
      "No hay agentes activos",
    )
    fireEvent.contextMenu(screen.getByTestId("project-card"))
    expect(screen.getByTestId("project-card-menu-thumbnail").textContent).toContain(
      "Establecer miniatura",
    )
    fireEvent.click(screen.getByTestId("project-card-menu-thumbnail"))
    expect(screen.getByRole("dialog", { name: "Establecer miniatura" })).toBeTruthy()
    act(() => setInterfaceLanguage("en"))
  })
  test("Digital Rain refreshes from paused to working without remounting", async () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)
    let activity: Array<{ projectId: string; state: "working" | "waiting" }> = [
      { projectId: "rain-working", state: "waiting" },
    ]

    const idle = renderCard(project({ id: "rain-idle", name: "Idle rain", digitalRain: true }), {
      "projects.digitalRainCharacters": () => ({ characters: "constrain=0" }),
    })
    expect(
      (await screen.findByTestId("project-card-digital-rain")).getAttribute("data-animating"),
    ).toBe("false")
    idle.unmount()

    renderCard(project({ id: "rain-working", name: "Working rain", digitalRain: true }), {
      "sessions.activity": () => activity,
      "projects.digitalRainCharacters": () => ({ characters: "constrain=1" }),
    })
    await waitFor(() =>
      expect(screen.getByTestId("project-card-status").textContent).toContain("Paused"),
    )
    expect(screen.getByTestId("project-card-digital-rain").getAttribute("data-animating")).toBe(
      "false",
    )

    activity = [{ projectId: "rain-working", state: "working" }]
    await new Promise((resolve) => window.setTimeout(resolve, 1_100))
    await waitFor(() =>
      expect(screen.getByTestId("project-card-digital-rain").getAttribute("data-animating")).toBe(
        "true",
      ),
    )
    expect(screen.getByTestId("project-card-status").textContent).toContain("Working")
    getContext.mockRestore()
  })

  test("highlights the entire card, including its action area, on hover", async () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)
    renderCard(project({ id: "hover-card", name: "Hover card", digitalRain: true }), {
      "projects.digitalRainCharacters": () => ({ characters: "rain=1" }),
    })

    const card = await screen.findByTestId("project-card")
    const body = screen.getByTestId("project-card-body")
    const actions = screen.getByTestId("project-card-actions")
    const title = screen.getByTestId("project-card-open")

    const image = screen.getByTestId("project-card-image")
    expect(card.className).not.toContain("brightness-105")
    expect(title.className).not.toContain("hover:bg-")
    expect(image.className).toContain("group-hover:brightness-105")
    expect(image.className).toContain("group-hover:contrast-105")
    expect(image.className).toContain("group-hover:saturate-125")
    expect(await screen.findByTestId("project-card-digital-rain")).toBeTruthy()
    const rainHover = screen.getByTestId("project-card-digital-rain-hover")
    expect(rainHover.className).toContain("group-hover:bg-white/[0.06]")
    expect(body.className).toContain("group-hover:brightness-105")
    expect(actions.className).toContain("group-hover:brightness-105")
    getContext.mockRestore()
  })

  test("opens the project when the blank body space above the action divider is clicked", async () => {
    renderCard(project({ id: "open-body", name: "Open body" }))

    fireEvent.click(await screen.findByTestId("project-card-body"))

    expect((await screen.findByTestId("on-project-route")).getAttribute("data-project-id")).toBe(
      "open-body",
    )
  })

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

  test("disables Git-only card actions with an Initialize Git explanation", async () => {
    renderCard(
      project({ id: "plain-folder", name: "Plain", metadata: null, defaultBranch: null }),
      {
        "projects.capabilities": () => ({ git: false }),
      },
    )

    const auto = await screen.findByTestId("project-card-auto-research")
    const fetch = screen.getByTestId("project-card-fetch-experiments")
    const summary = screen.getByTestId("project-card-summary")

    for (const button of [auto, fetch, summary]) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
      expect(button.getAttribute("data-feature-help")).toContain("Initialize Git")
    }

    fireEvent.click(auto)
    expect(screen.queryByTestId("on-project-route")).toBeNull()
    expect(readPendingLaunch("plain-folder")).toBeNull()
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

    fireEvent.contextMenu(await screen.findByTestId("project-card-body"))
    fireEvent.click(screen.getByTestId("project-card-menu-edit"))

    const dialog = screen.getByTestId("edit-project-dialog")
    fireEvent.change(within(dialog).getByTestId("edit-project-collaborators"), {
      target: { value: "Grace Hopper" },
    })
    fireEvent.click(within(dialog).getByTestId("edit-project-save"))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ id: "p4", metadata: { collaborators: "Grace Hopper" } })
  })

  test("Set thumbnail opens an artwork chooser for a file, gradient, or Digital Rain", async () => {
    const gradientCalls: unknown[] = []
    const digitalRainCalls: unknown[] = []
    renderCard(project({ id: "artwork-card", name: "Artwork" }), {
      "projects.setGradient": (input) => {
        gradientCalls.push(input)
        return project({ id: "artwork-card", name: "Artwork" })
      },
      "projects.setDigitalRain": (input) => {
        digitalRainCalls.push(input)
        return project({ id: "artwork-card", name: "Artwork", digitalRain: true })
      },
    })

    const image = await screen.findByTestId("project-card-image")
    const picker = screen.getByTestId("project-card-thumbnail-input")
    const pickerClick = vi.spyOn(picker, "click")
    fireEvent.contextMenu(image)
    expect(screen.queryByTestId("project-card-menu-gradient")).toBeNull()

    fireEvent.click(screen.getByTestId("project-card-menu-thumbnail"))
    const dialog = screen.getByTestId("project-card-artwork-dialog")
    expect(dialog).toBeTruthy()

    fireEvent.click(within(dialog).getByTestId("project-card-artwork-file"))
    expect(pickerClick).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("project-card-artwork-dialog")).toBeNull()

    fireEvent.contextMenu(image)
    fireEvent.click(screen.getByTestId("project-card-menu-thumbnail"))
    fireEvent.click(screen.getByTestId("project-card-artwork-gradient"))
    await waitFor(() => expect(gradientCalls).toHaveLength(1))
    expect(gradientCalls[0]).toMatchObject({ id: "artwork-card" })
    expect(screen.queryByTestId("project-card-artwork-dialog")).toBeNull()

    fireEvent.contextMenu(image)
    fireEvent.click(screen.getByTestId("project-card-menu-thumbnail"))
    fireEvent.click(screen.getByTestId("project-card-artwork-digital-rain"))
    await waitFor(() => expect(digitalRainCalls).toEqual([{ id: "artwork-card", enabled: true }]))
    expect(screen.queryByTestId("project-card-artwork-dialog")).toBeNull()
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
    // A running control shows a transform-only moving underline, keeping the
    // workflow window stable while the agent streams activity updates.
    expect(summary.querySelector(".pi-lab-workflow-sweep")).toBeTruthy()
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
