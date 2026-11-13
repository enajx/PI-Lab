import { QueryClient } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { useSciencePanelWidth } from "../../../../../preferences/preferences"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import {
  readProjectPinnedPanels,
  writeProjectPinnedPanels,
} from "../../../projects/-workspaceState"

/**
 * The Tasks and Analysis session panel, driven through its public component with a
 * faked tRPC client (mocked: no main process). xterm needs layout APIs jsdom lacks, so
 * the terminal is a stub that shows its session id.
 */
vi.mock("../../../../../Terminal", () => ({
  Terminal: ({ inputKind, sessionId }: { inputKind: "agent" | "terminal"; sessionId?: string }) => (
    <div data-testid="terminal" data-input-kind={inputKind} data-session-id={sessionId} />
  ),
}))

const {
  ScienceSessionPanel,
  SciencePanelCollapsedBar,
  SciencePanelDiaryButton,
  useSciencePanel,
  useSciencePanelRow,
  SESSIONS_TAB_ID,
} = await import("./ScienceSessionPanel")
const { DIARY_TAB_ID } = await import("../../../projects/components/RightSidebar")

let ensured: string[]
let started: Array<{ agentId: string; origin: string; projectId: string }>

beforeEach(() => {
  window.localStorage.clear()
  // Most tests start from a diary turned off, so the panel starts collapsed.
  window.localStorage.setItem("pi-lab.researchDiary.open", "false")
  ensured = []
  started = []
})

function handlers(): FakeHandlers {
  return {
    "workspaces.ensureMain": (input) => {
      ensured.push((input as { projectId: string }).projectId)
      return { id: "ws-1" }
    },
    "settings.get": () => ({ agents: { defaultAgentId: "claude-code" } }),
    "settings.updateEditor": () => ({}),
    "agents.list": () => [
      { id: "claude-code", label: "Claude Code", available: true, executable: "/usr/bin/claude" },
    ],
    "agents.projectChoice": () => ({ agentId: null, storage: "app" }),
    "sessions.start": (input) => {
      started.push(input as { agentId: string; origin: string; projectId: string })
      return { sessionId: `agent-${started.length}`, workspaceId: "ws-1", kind: "branch" }
    },
    "workspaces.spawnTerminal": () => ({ sessionId: "term-1" }),
    "terminal.list": () => [],
    "terminal.kill": () => ({ ok: true }),
    "files.tree": () => [],
    "files.read": () => ({ content: "", exists: false }),
    "projects.get": () => ({ id: "p-1", name: "Project 1" }),
    "projects.capabilities": () => ({ git: true }),
    "diary.open": () => ({
      relPath: "md/research-diary/diary.md",
      content: "## 2026-11-12\n\n",
      baseline: { exists: true, mtimeMs: 1, size: 15 },
    }),
  }
}

/** The panel with the top bar diary button, as a view puts them. */
function Harness({
  view,
  project,
}: {
  view: "tasks" | "analysis"
  project: { id: string; name: string } | null
}) {
  const panel = useSciencePanel(view, view === "analysis" ? SESSIONS_TAB_ID : DIARY_TAB_ID)
  const row = useSciencePanelRow(panel, useSciencePanelWidth(), 300, null, {
    preferred: 320,
    min: 320,
  })
  return (
    <>
      <SciencePanelDiaryButton
        testId="diary-button"
        panel={row.panel}
        disabled={project === null}
      />
      <SciencePanelCollapsedBar testId="collapsed-bar" panel={row.panel} />
      <ScienceSessionPanel
        view={view}
        project={project}
        panel={row.panel}
        width={row.width}
        openSession={null}
        onSessionOpened={() => undefined}
      />
    </>
  )
}

function renderPanel(
  view: "tasks" | "analysis",
  project: { id: string; name: string } | null,
  fake: FakeHandlers,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(fake)
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <Harness view={view} project={project} />
    </AppProviders>,
  )
}

/** Wait until the agent button can act, so ⌘T is not ignored as "pending". */
async function agentReady(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByTestId("central-new-agent").hasAttribute("disabled")).toBe(false),
  )
}

/** Whether the right sidebar tab `id` is the selected one. */
function tabSelected(id: string): string | null {
  return screen.getByTestId(`panel-tab-${id}`).getAttribute("aria-selected")
}

/** The right sidebar tab ids in their shown order. */
function tabIds(): string[] {
  return screen
    .getAllByRole("tab")
    .map((tab) => (tab.getAttribute("data-testid") ?? "").replace("panel-tab-", ""))
}

describe("ScienceSessionPanel", () => {
  test("starts collapsed, and ⌘T opens an agent in the project and shows the Sessions tab", async () => {
    renderPanel("analysis", { id: "p-1", name: "Project 1" }, handlers())
    await agentReady()
    expect(screen.getByTestId("science-sessions").getAttribute("data-collapsed")).toBe("true")
    expect(screen.getByTestId("collapsed-bar")).toBeTruthy()

    fireEvent.keyDown(window, { key: "t", metaKey: true })

    await screen.findByTestId("terminal")
    expect(started).toEqual([
      expect.objectContaining({ agentId: "claude-code", origin: "analysis", projectId: "p-1" }),
    ])
    expect(ensured).toContain("p-1")
    expect(screen.getByTestId("science-sessions").getAttribute("data-collapsed")).toBe("false")
    expect(screen.queryByTestId("collapsed-bar")).toBeNull()
    expect(tabSelected("sessions")).toBe("true")
  })

  test("keeps its tabs when the view is left and opened again", async () => {
    const first = renderPanel("tasks", { id: "p-1", name: "Project 1" }, handlers())
    await agentReady()
    fireEvent.keyDown(window, { key: "t", metaKey: true })
    await screen.findByTestId("terminal")
    expect(started[0]?.origin).toBe("tasks")
    first.unmount()

    // The agent's PTY is still alive, so the restored tab reattaches to it.
    renderPanel(
      "tasks",
      { id: "p-1", name: "Project 1" },
      {
        ...handlers(),
        "terminal.list": () => [{ id: "agent-1", alive: true }],
      },
    )

    const terminal = await screen.findByTestId("terminal")
    expect(terminal.getAttribute("data-session-id")).toBe("agent-1")
    expect(screen.getByTestId("science-sessions").getAttribute("data-collapsed")).toBe("false")
    // The last tab of the view is kept.
    expect(tabSelected("sessions")).toBe("true")
  })

  test("with no project, ⌘T and the panel buttons ask to pick a project", async () => {
    renderPanel("tasks", null, handlers())

    act(() => {
      fireEvent.keyDown(window, { key: "t", metaKey: true })
    })
    expect((await screen.findByTestId("science-sessions-notice")).textContent).toBe(
      "Pick a project to open a session",
    )
    expect(screen.getByTestId("science-sessions").getAttribute("data-collapsed")).toBe("false")

    fireEvent.click(screen.getByTestId("science-sessions-dismiss-notice"))
    expect(screen.queryByTestId("science-sessions-notice")).toBeNull()
    fireEvent.click(screen.getByTestId("science-sessions-new-terminal"))
    expect(screen.getByTestId("science-sessions-notice")).toBeTruthy()
    expect(ensured).toEqual([])
    expect(started).toEqual([])
  })

  test("with the diary on (the default), Tasks starts open on the Diary tab", async () => {
    window.localStorage.removeItem("pi-lab.researchDiary.open")
    window.sessionStorage.clear()
    renderPanel("tasks", { id: "p-1", name: "Project 1" }, handlers())
    expect(screen.getByTestId("science-sessions").getAttribute("data-collapsed")).toBe("false")
    expect(screen.getByTestId("diary-button").getAttribute("aria-pressed")).toBe("true")
    expect(await screen.findByTestId("research-diary-panel")).toBeTruthy()
    expect(tabSelected("diary")).toBe("true")
  })

  test("Analysis starts open on the Sessions tab", async () => {
    window.localStorage.removeItem("pi-lab.researchDiary.open")
    window.sessionStorage.clear()
    renderPanel("analysis", { id: "p-1", name: "Project 1" }, handlers())
    expect(screen.getByTestId("science-sessions").getAttribute("data-collapsed")).toBe("false")
    await screen.findByTestId("panel-tab-sessions")
    expect(tabSelected("sessions")).toBe("true")
    expect(screen.getByTestId("diary-button").getAttribute("aria-pressed")).toBe("false")
  })

  test("the diary button opens the panel on the Diary tab, and while it shows hides the panel", async () => {
    // A project with no tabs saved by the tests above (restored tabs open the panel).
    renderPanel("analysis", { id: "p-2", name: "Project 2" }, handlers())
    const aside = screen.getByTestId("science-sessions")
    const button = screen.getByTestId("diary-button")
    expect(aside.getAttribute("data-collapsed")).toBe("true")

    fireEvent.click(button)
    expect(aside.getAttribute("data-collapsed")).toBe("false")
    expect(button.getAttribute("aria-pressed")).toBe("true")
    const diary = await screen.findByTestId("research-diary-panel")
    expect(aside.contains(diary)).toBe(true)
    // One box: a single right sidebar in the panel.
    expect(within(aside).getAllByTestId("right-sidebar")).toHaveLength(1)

    fireEvent.click(button)
    expect(aside.getAttribute("data-collapsed")).toBe("true")
    expect(button.getAttribute("aria-pressed")).toBe("false")

    fireEvent.click(button)
    expect(aside.getAttribute("data-collapsed")).toBe("false")
    expect(tabSelected("diary")).toBe("true")
  })

  test("the panel is the project view's right sidebar with Sessions first, one collapse button, and the pins the project view saved", async () => {
    window.localStorage.removeItem("pi-lab.researchDiary.open")
    writeProjectPinnedPanels("p-1", ["notes/plan.md"])
    renderPanel("tasks", { id: "p-1", name: "Project 1" }, handlers())
    const aside = screen.getByTestId("science-sessions")
    const sidebar = await within(aside).findByTestId("right-sidebar")
    const tabs = within(sidebar).getAllByRole("tab")
    expect(tabs[0]?.getAttribute("data-testid")).toBe("panel-tab-sessions")
    expect(within(sidebar).getByTestId("panel-tab-research")).toBeTruthy()
    expect(within(sidebar).getByTestId("panel-tab-todos")).toBeTruthy()
    expect(within(sidebar).getByTestId("panel-tab-files")).toBeTruthy()
    expect(within(sidebar).getByTestId("panel-tab-pinned:notes/plan.md")).toBeTruthy()
    // Tasks opens on the Diary.
    expect(tabSelected("diary")).toBe("true")

    // On another tab the diary button shows the Diary tab again.
    const button = screen.getByTestId("diary-button")
    fireEvent.click(within(sidebar).getByTestId("panel-tab-todos"))
    expect(button.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(button)
    expect(tabSelected("diary")).toBe("true")
    expect(button.getAttribute("aria-pressed")).toBe("true")

    // Unpinning here changes the project's own list.
    fireEvent.click(await screen.findByTestId("right-sidebar-unpin:notes/plan.md"))
    expect(readProjectPinnedPanels("p-1")).toEqual([])

    // The sidebar's collapse button collapses the whole panel.
    fireEvent.click(within(sidebar).getByTestId("right-sidebar-collapse"))
    expect(aside.getAttribute("data-collapsed")).toBe("true")
    expect(screen.getByTestId("collapsed-bar")).toBeTruthy()
  })

  test("sessions stay mounted while another tab shows, and a new session shows the Sessions tab", async () => {
    window.localStorage.removeItem("pi-lab.researchDiary.open")
    renderPanel("tasks", { id: "p-3", name: "Project 3" }, handlers())
    await agentReady()
    expect(tabSelected("diary")).toBe("true")
    const sessions = screen.getByTestId("panel-sessions")
    expect(sessions.hidden).toBe(true)

    fireEvent.keyDown(window, { key: "t", metaKey: true })
    const terminal = await screen.findByTestId("terminal")
    expect(tabSelected("sessions")).toBe("true")
    expect(sessions.hidden).toBe(false)

    fireEvent.click(screen.getByTestId("panel-tab-diary"))
    expect(await screen.findByTestId("research-diary-panel")).toBeTruthy()
    expect(sessions.hidden).toBe(true)
    // The same terminal node: hidden, not unmounted.
    expect(screen.getByTestId("terminal")).toBe(terminal)
    expect(terminal.isConnected).toBe(true)
  })

  test("Analysis shows only the Sessions, Files and Diary tabs by default; Tasks shows them all", async () => {
    window.localStorage.removeItem("pi-lab.researchDiary.open")
    writeProjectPinnedPanels("p-4", ["notes/plan.md"])
    const analysis = renderPanel("analysis", { id: "p-4", name: "Project 4" }, handlers())
    await screen.findByTestId("right-sidebar")
    expect(tabIds()).toEqual(["sessions", "files", "diary"])
    analysis.unmount()

    renderPanel("tasks", { id: "p-4", name: "Project 4" }, handlers())
    await screen.findByTestId("right-sidebar")
    expect(tabIds()).toEqual([
      "sessions",
      "files",
      "research",
      "todos",
      "diary",
      "pinned:notes/plan.md",
    ])
  })

  test("the pin menu lists the tabs with which are shown, and a shown tab is kept per view", async () => {
    window.localStorage.removeItem("pi-lab.researchDiary.open")
    const first = renderPanel("analysis", { id: "p-5", name: "Project 5" }, handlers())
    await screen.findByTestId("right-sidebar")
    fireEvent.click(screen.getByTestId("right-sidebar-pin"))
    const menu = screen.getByTestId("pin-menu")
    const rows = within(menu).getAllByRole("menuitemcheckbox")
    expect(
      rows.map((row) => [row.getAttribute("data-tab-id"), row.getAttribute("aria-checked")]),
    ).toEqual([
      ["sessions", "true"],
      ["files", "true"],
      ["research", "false"],
      ["todos", "false"],
      ["diary", "true"],
    ])
    // The file search is below the tab list.
    expect(within(menu).getByTestId("pin-menu-search")).toBeTruthy()

    fireEvent.click(within(menu).getByTestId("pin-menu-tab-research"))
    expect(within(menu).getByTestId("pin-menu-tab-research").getAttribute("aria-checked")).toBe(
      "true",
    )
    expect(tabIds()).toEqual(["sessions", "files", "research", "diary"])
    first.unmount()

    // Kept after a reload, and only for Analysis.
    const second = renderPanel("analysis", { id: "p-5", name: "Project 5" }, handlers())
    await screen.findByTestId("right-sidebar")
    expect(tabIds()).toEqual(["sessions", "files", "research", "diary"])
    second.unmount()
    renderPanel("tasks", { id: "p-5", name: "Project 5" }, handlers())
    await screen.findByTestId("right-sidebar")
    expect(tabIds()).toEqual(["sessions", "files", "research", "todos", "diary"])
  })

  test("hiding the shown tab moves to another tab, and a tab that is asked for shows again", async () => {
    window.localStorage.removeItem("pi-lab.researchDiary.open")
    renderPanel("analysis", { id: "p-6", name: "Project 6" }, handlers())
    await screen.findByTestId("right-sidebar")
    fireEvent.click(screen.getByTestId("panel-tab-diary"))
    fireEvent.click(screen.getByTestId("right-sidebar-pin"))
    fireEvent.click(screen.getByTestId("pin-menu-tab-diary"))
    expect(tabIds()).toEqual(["sessions", "files"])
    expect(tabSelected("sessions")).toBe("true")
    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByTestId("pin-menu")).toBeNull()

    // The top bar diary button shows the Diary tab again.
    fireEvent.click(screen.getByTestId("diary-button"))
    expect(tabIds()).toEqual(["sessions", "files", "diary"])
    expect(tabSelected("diary")).toBe("true")
  })

  test("with no project, the diary button is disabled and the panel shows only Sessions", async () => {
    renderPanel("tasks", null, handlers())
    expect(screen.getByTestId("diary-button").hasAttribute("disabled")).toBe(true)
    fireEvent.click(screen.getByTestId("science-sessions-expand"))
    expect(screen.queryByTestId("research-diary-panel")).toBeNull()
    expect(screen.queryByTestId("right-sidebar")).toBeNull()
  })
})
