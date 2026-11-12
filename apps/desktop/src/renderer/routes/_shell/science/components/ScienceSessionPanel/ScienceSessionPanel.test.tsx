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
  SciencePanelDiaryButton,
  SciencePanelExpandButton,
  useSciencePanel,
  useSciencePanelRow,
} = await import("./ScienceSessionPanel")

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
  const row = useSciencePanelRow(useSciencePanel(), useSciencePanelWidth(), 300, null, {
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
      <SciencePanelExpandButton panel={row.panel} />
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
  fireEvent.click(await screen.findByTestId("science-sessions-expand"))
  await waitFor(() =>
    expect(screen.getByTestId("central-new-agent").hasAttribute("disabled")).toBe(false),
  )
  fireEvent.click(screen.getByTestId("science-sessions-collapse"))
}

describe("ScienceSessionPanel", () => {
  test("starts collapsed, and ⌘T opens an agent in the project and shows the panel", async () => {
    renderPanel("analysis", { id: "p-1", name: "Project 1" }, handlers())
    await agentReady()
    expect(screen.getByTestId("science-sessions").getAttribute("data-collapsed")).toBe("true")

    fireEvent.keyDown(window, { key: "t", metaKey: true })

    await screen.findByTestId("terminal")
    expect(started).toEqual([
      expect.objectContaining({ agentId: "claude-code", origin: "analysis", projectId: "p-1" }),
    ])
    expect(ensured).toContain("p-1")
    expect(screen.getByTestId("science-sessions").getAttribute("data-collapsed")).toBe("false")
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

  test("with the diary on (the default), the panel starts open with the diary below Sessions", async () => {
    window.localStorage.removeItem("pi-lab.researchDiary.open")
    renderPanel("analysis", { id: "p-1", name: "Project 1" }, handlers())
    expect(screen.getByTestId("science-sessions").getAttribute("data-collapsed")).toBe("false")
    expect(screen.getByTestId("diary-button").getAttribute("aria-pressed")).toBe("true")
    expect(await screen.findByTestId("research-diary-panel")).toBeTruthy()
  })

  test("the diary button opens the panel with the diary below Sessions, then hides and shows the diary; collapsing hides both", async () => {
    renderPanel("analysis", { id: "p-1", name: "Project 1" }, handlers())
    const aside = screen.getByTestId("science-sessions")
    const button = screen.getByTestId("diary-button")
    expect(aside.getAttribute("data-collapsed")).toBe("true")
    expect(screen.queryByTestId("research-diary-panel")).toBeNull()

    fireEvent.click(button)
    expect(aside.getAttribute("data-collapsed")).toBe("false")
    expect(button.getAttribute("aria-pressed")).toBe("true")
    const diary = await screen.findByTestId("research-diary-panel")
    expect(aside.contains(diary)).toBe(true)
    expect(screen.getByTestId("science-panel-divider")).toBeTruthy()
    // Sessions come first, the diary below the divider.
    const sessions = screen.getByTestId("science-panel-sessions")
    expect(sessions.compareDocumentPosition(diary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(button)
    expect(screen.queryByTestId("research-diary-panel")).toBeNull()
    expect(screen.queryByTestId("science-panel-divider")).toBeNull()
    expect(aside.getAttribute("data-collapsed")).toBe("false")
    expect(button.getAttribute("aria-pressed")).toBe("false")

    fireEvent.click(button)
    expect(await screen.findByTestId("research-diary-panel")).toBeTruthy()
    fireEvent.click(screen.getByTestId("science-sessions-collapse"))
    expect(aside.getAttribute("data-collapsed")).toBe("true")
    expect(screen.queryByTestId("research-diary-panel")).toBeNull()
    expect(button.getAttribute("aria-pressed")).toBe("false")

    // Opening the panel again shows the diary, still on.
    fireEvent.click(screen.getByTestId("science-sessions-expand"))
    expect(await screen.findByTestId("research-diary-panel")).toBeTruthy()
  })

  test("the documents card is the project view's right sidebar: its tabs, no collapse button of its own, and the pins the project view saved", async () => {
    window.localStorage.removeItem("pi-lab.researchDiary.open")
    writeProjectPinnedPanels("p-1", ["notes/plan.md"])
    renderPanel("analysis", { id: "p-1", name: "Project 1" }, handlers())
    const card = screen.getByTestId("science-panel-diary")
    const sidebar = await within(card).findByTestId("right-sidebar")
    expect(within(sidebar).getByTestId("panel-tab-research")).toBeTruthy()
    expect(within(sidebar).getByTestId("panel-tab-todos")).toBeTruthy()
    expect(within(sidebar).getByTestId("panel-tab-files")).toBeTruthy()
    expect(within(sidebar).getByTestId("panel-tab-pinned:notes/plan.md")).toBeTruthy()
    expect(within(sidebar).queryByTestId("right-sidebar-collapse")).toBeNull()
    expect(within(sidebar).getByTestId("panel-tab-diary").getAttribute("aria-selected")).toBe(
      "true",
    )

    // On another tab the diary button shows the Diary tab again, then hides the documents.
    const button = screen.getByTestId("diary-button")
    fireEvent.click(within(sidebar).getByTestId("panel-tab-todos"))
    expect(button.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(button)
    expect(within(sidebar).getByTestId("panel-tab-diary").getAttribute("aria-selected")).toBe(
      "true",
    )
    expect(button.getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(button)
    expect(screen.queryByTestId("science-panel-diary")).toBeNull()

    // Unpinning here changes the project's own list.
    fireEvent.click(button)
    fireEvent.click(await screen.findByTestId("right-sidebar-unpin:notes/plan.md"))
    expect(readProjectPinnedPanels("p-1")).toEqual([])
  })

  test("with no project, the diary button is disabled and the panel shows only Sessions", async () => {
    renderPanel("tasks", null, handlers())
    expect(screen.getByTestId("diary-button").hasAttribute("disabled")).toBe(true)
    fireEvent.click(screen.getByTestId("science-sessions-expand"))
    expect(screen.queryByTestId("research-diary-panel")).toBeNull()
  })
})
