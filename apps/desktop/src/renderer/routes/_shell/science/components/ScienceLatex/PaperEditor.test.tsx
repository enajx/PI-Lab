import { DEFAULT_EDITOR_SETTINGS } from "@pi-lab/local-db/editor-settings"
import { QueryClient } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { BuildResult } from "../../../../../../main/trpc/pdf/pdf"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"

/**
 * Component tests for the LaTeX Editor workspace: its agent tabs and their
 * restore. The tRPC server is a fake (mocked), so these check the renderer flow
 * only; the e2e test covers the real app. xterm and CodeMirror need layout APIs
 * jsdom lacks, so both are stubbed.
 */
vi.mock("../../../../../Terminal", () => ({
  Terminal: ({ sessionId }: { sessionId?: string }) => (
    <div data-testid="terminal" data-session-id={sessionId} />
  ),
}))

vi.mock("../../../../../Editor/components/CodeMirrorBuffer", () => ({
  // A Save button stands in for Cmd+S in the real editor.
  CodeMirrorBuffer: ({ relPath, onSave }: { relPath: string; onSave: () => void }) => (
    <div data-testid="editor-buffer">
      {relPath}
      <button type="button" data-testid="mock-save" onClick={onSave} />
    </div>
  ),
}))

const { PaperEditor } = await import("./PaperEditor")

let started: unknown[]
let liveSessionIds: string[]
let startWarning: string | null

beforeEach(() => {
  started = []
  liveSessionIds = []
  startWarning = null
})

function handlers(): FakeHandlers {
  return {
    "paper.outline": () => [],
    "files.tree": () => [{ name: "main.tex", relPath: "main.tex", kind: "file" as const }],
    "files.read": () => ({
      status: "text",
      exists: true,
      content: "\\documentclass{article}\n",
      baseline: { exists: true, mtimeMs: 1, size: 24 },
    }),
    "files.stat": () => ({ exists: false, mtimeMs: 0, size: 0 }),
    "settings.get": () => ({ agents: { defaultAgentId: "claude-code" } }),
    "agents.list": () => [
      { id: "claude-code", label: "Claude Code", available: true, executable: "/bin/claude" },
    ],
    "agents.projectChoice": () => ({ agentId: null, storage: "app" }),
    "sessions.start": (input) => {
      started.push(input)
      const sessionId = `agent-${started.length}`
      liveSessionIds.push(sessionId)
      return { sessionId, workspaceId: "paper-ws", kind: "branch", warning: startWarning }
    },
    "terminal.list": () => liveSessionIds.map((id) => ({ id, alive: true })),
    "terminal.kill": () => ({ ok: true }),
    "latex.status": () => ({
      provider: "auto",
      bundled: { available: true, version: "Tectonic 0.15.0", name: "Tectonic", error: null },
      system: { available: false, version: null, name: "System LaTeX", error: "Not found" },
      engine: { kind: "bundled", name: "Tectonic" },
      installation: { state: "idle", progress: null, message: "", error: null },
    }),
    "science.skills.list": () => ({
      skills: [
        {
          name: "Review notes",
          description: "Review the lab notes",
          slug: "review-notes",
          path: "/proj/.claude/skills/review-notes/SKILL.md",
          source: "Project Claude",
          harness: "claude",
          scope: "project",
        },
      ],
      roots: [],
    }),
    "automations.list": () => [],
    "sessions.startSkill": (input) => {
      started.push(input)
      const sessionId = `skill-${started.length}`
      liveSessionIds.push(sessionId)
      return {
        sessionId,
        workspaceId: "paper-ws",
        kind: "branch",
        warning: null,
        agentId: "claude-code",
        label: "Review notes",
      }
    },
    "paper.startUpdate": (input) => {
      started.push(input)
      const sessionId = `update-${started.length}`
      liveSessionIds.push(sessionId)
      return {
        sessionId,
        workspaceId: "paper-ws",
        kind: "branch",
        warning: null,
        agentId: "claude-code",
      }
    },
  }
}

/** Mount the LaTeX Editor workspace for a project as the page does. */
function renderEditor(
  client: ReturnType<typeof createFakeTrpcClient>,
  projectId: string,
  focusSession: { sessionId: string; agentId: string; agentLabel: string } | null,
  createdBuild: Promise<BuildResult> | null,
  syncSlot: HTMLElement | null,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <PaperEditor
        createdBuild={createdBuild}
        picker={null}
        diaryButton={null}
        projectId={projectId}
        projectName="Project"
        workspaceId="paper-ws"
        paperDir="/proj/paper"
        displayDir="paper"
        rootRelPath="main.tex"
        lastSyncAt={null}
        hasRemote={false}
        syncEnabled={true}
        outputDir={null}
        effectiveOutputDir="build"
        settings={DEFAULT_EDITOR_SETTINGS}
        onUpdateEditorSettings={() => undefined}
        focusSession={focusSession}
        syncSlot={syncSlot}
      />
    </AppProviders>,
  )
}

/** A `files.stat` answer: files in `mtimes` exist with that modification time; others are missing. */
function statFiles(
  input: unknown,
  mtimes: Record<string, number>,
): { exists: boolean; mtimeMs: number; size: number } {
  const mtimeMs = mtimes[(input as { relPath: string }).relPath]
  return mtimeMs === undefined
    ? { exists: false, mtimeMs: 0, size: 0 }
    : { exists: true, mtimeMs, size: 10 }
}

function tabLabels(): string[] {
  return screen
    .getAllByTestId("central-tab")
    .map((tab) => within(tab).getByTestId("central-tab-select").getAttribute("aria-label") ?? "")
}

describe("PaperEditor agents (mocked server)", () => {
  test("starts agents as LaTeX Editor agents and keeps its tabs after leaving and coming back", async () => {
    const client = createFakeTrpcClient(handlers())
    renderEditor(client, "p1", null, null, null)
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex"]))
    await waitFor(() =>
      expect(screen.getByTestId("central-new-agent").hasAttribute("disabled")).toBe(false),
    )
    fireEvent.click(screen.getByTestId("central-new-agent"))
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex", "Claude Code"]))
    expect(started).toEqual([expect.objectContaining({ projectId: "p1", origin: "latex" })])

    // Leave the page (unmount) and come back.
    cleanup()
    renderEditor(client, "p1", null, null, null)
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex", "Claude Code"]))
    const agentTab = screen
      .getAllByTestId("central-tab")
      .find((tab) => tab.getAttribute("data-tab-kind") === "agent")
    expect(agentTab?.getAttribute("data-active")).toBe("true")
    expect(started).toHaveLength(1)
    cleanup()
  })

  test("a requested agent session is focused, and attached as a tab when it is not open yet", async () => {
    liveSessionIds = ["live-latex-agent"]
    const client = createFakeTrpcClient(handlers())
    renderEditor(
      client,
      "p2",
      {
        sessionId: "live-latex-agent",
        agentId: "claude-code",
        agentLabel: "Claude Code",
      },
      null,
      null,
    )
    await waitFor(() => expect(tabLabels()).toContain("Claude Code"))
    const agentTab = screen
      .getAllByTestId("central-tab")
      .find((tab) => tab.getAttribute("data-tab-kind") === "agent")
    expect(agentTab?.getAttribute("data-active")).toBe("true")
    expect(screen.getByTestId("terminal").getAttribute("data-session-id")).toBe("live-latex-agent")
    expect(started).toEqual([])
    cleanup()
  })

  test("a start warning (agent cannot be given the paper folder) is shown near the tabs", async () => {
    startWarning =
      "Claude Code cannot be given the paper folder /papers/p; it only sees the project folder."
    const client = createFakeTrpcClient(handlers())
    renderEditor(client, "p3", null, null, null)
    await waitFor(() =>
      expect(screen.getByTestId("central-new-agent").hasAttribute("disabled")).toBe(false),
    )
    fireEvent.click(screen.getByTestId("central-new-agent"))
    expect((await screen.findByTestId("central-launch-warning")).textContent).toContain(
      startWarning,
    )
    cleanup()
  })
})

describe("PaperEditor left column (mocked server)", () => {
  test("the column starts hidden; once opened, Files and Outline are both expanded, Outline below Files", async () => {
    for (const key of ["leftColumn", "filesOpen", "outlineOpen"]) {
      window.localStorage.removeItem(`pi-lab.latexEditor.${key}`)
    }
    const client = createFakeTrpcClient(handlers())
    renderEditor(client, "p4", null, null, null)
    const toggle = await screen.findByTestId("central-files-toggle")
    expect(screen.queryByTestId("central-files-panel")).toBeNull()
    fireEvent.click(toggle)
    const column = await screen.findByTestId("central-files-panel")
    const files = within(column).getByTestId("central-files-section")
    const outline = within(column).getByTestId("paper-outline-section")
    expect(files.getAttribute("aria-expanded")).toBe("true")
    expect(outline.getAttribute("aria-expanded")).toBe("true")
    // Files comes first in the column, Outline after it.
    expect(files.compareDocumentPosition(outline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // A saved collapsed state still applies.
    fireEvent.click(files)
    await waitFor(() => expect(within(column).queryByTestId("panel-files")).toBeNull())
    expect(window.localStorage.getItem("pi-lab.latexEditor.filesOpen")).toContain("false")
    cleanup()
  })
})

describe("PaperEditor Start draft and Update paper (mocked server)", () => {
  test("a just-created paper opens with the PDF its Start draft build made, without building again", async () => {
    const builds: unknown[] = []
    const client = createFakeTrpcClient({
      ...handlers(),
      // Start draft built the PDF after main.tex was written.
      "files.stat": (input) => statFiles(input, { "main.tex": 1, "build/main.pdf": 2 }),
      "pdf.build": (input) => {
        builds.push(input)
        return { relPath: "build/main.pdf", success: true, log: "" }
      },
    })
    const created = Promise.resolve({ relPath: "build/main.pdf", success: true, log: "" })
    renderEditor(client, "p5", null, created, null)
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex", "main.pdf"]))
    expect(builds).toEqual([])
    cleanup()
  })

  test("a failed Start draft build opens main.tex with the build failure and its log", async () => {
    const client = createFakeTrpcClient({
      ...handlers(),
      "files.stat": (input) => statFiles(input, { "main.tex": 1 }),
    })
    const created = Promise.resolve({
      relPath: "build/main.pdf",
      success: false,
      log: "! Undefined control sequence.",
    })
    renderEditor(client, "p9", null, created, null)
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex"]))
    const status = await screen.findByTestId("latex-build-status")
    await waitFor(() => expect(status.textContent).toContain("LaTeX build failed"))
    fireEvent.click(within(status).getByRole("button"))
    expect(screen.getByTestId("latex-build-log").textContent).toContain(
      "! Undefined control sequence.",
    )
    cleanup()
  })

  test("Start draft's build that could not run at all opens main.tex with the error", async () => {
    const client = createFakeTrpcClient({
      ...handlers(),
      "files.stat": (input) => statFiles(input, { "main.tex": 1 }),
    })
    const created = Promise.reject(new Error("No LaTeX engine found"))
    created.catch(() => undefined)
    renderEditor(client, "p10", null, created, null)
    const status = await screen.findByTestId("latex-build-status")
    await waitFor(() => expect(status.textContent).toContain("LaTeX build failed"))
    fireEvent.click(within(status).getByRole("button"))
    expect(screen.getByTestId("latex-build-log").textContent).toContain("No LaTeX engine found")
    cleanup()
  })

  test("an existing paper with no PDF builds it when it opens and shows it beside the source", async () => {
    const builds: unknown[] = []
    const client = createFakeTrpcClient({
      ...handlers(),
      // The PDF exists only once the build has run.
      "files.stat": (input) =>
        statFiles(
          input,
          builds.length > 0 ? { "main.tex": 1, "build/main.pdf": 2 } : { "main.tex": 1 },
        ),
      "pdf.build": (input) => {
        builds.push(input)
        return { relPath: "build/main.pdf", success: true, log: "" }
      },
    })
    renderEditor(client, "p6", null, null, null)
    await waitFor(() => expect(builds).toEqual([{ workspaceId: "paper-ws", relPath: "main.tex" }]))
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex", "main.pdf"]))
    cleanup()
  })

  test("an existing paper whose PDF is older than main.tex rebuilds it when it opens", async () => {
    const builds: unknown[] = []
    const client = createFakeTrpcClient({
      ...handlers(),
      "files.stat": (input) =>
        statFiles(input, { "main.tex": 5, "build/main.pdf": builds.length > 0 ? 6 : 2 }),
      "pdf.build": (input) => {
        builds.push(input)
        return { relPath: "build/main.pdf", success: true, log: "" }
      },
    })
    renderEditor(client, "p11", null, null, null)
    await waitFor(() => expect(builds).toEqual([{ workspaceId: "paper-ws", relPath: "main.tex" }]))
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex", "main.pdf"]))
    cleanup()
  })

  test("a build into another output folder replaces the PDF tab beside the source with the new PDF", async () => {
    const openedPdfs: string[] = []
    const client = createFakeTrpcClient({
      ...handlers(),
      "files.stat": (input) => {
        const relPath = (input as { relPath: string }).relPath
        if (relPath.endsWith(".pdf")) openedPdfs.push(relPath)
        return statFiles(input, { "main.tex": 1, "build/main.pdf": 2, "pdfout/main.pdf": 3 })
      },
      "files.read": () => ({
        status: "text",
        exists: true,
        content: "\\documentclass{article}\n",
        baseline: { exists: true, mtimeMs: 1, size: 10 },
      }),
      "files.write": () => ({ mtimeMs: 4, size: 10 }),
      // The output folder was changed to pdfout, so the next build writes there.
      "pdf.build": () => ({ relPath: "pdfout/main.pdf", success: true, log: "" }),
    })
    renderEditor(client, "p13", null, null, null)
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex", "main.pdf"]))
    // Save main.tex (focused, as when typing in it).
    fireEvent.click(
      within(screen.getAllByTestId("central-tab")[0] as HTMLElement).getByTestId(
        "central-tab-select",
      ),
    )
    fireEvent.click(screen.getByTestId("mock-save"))
    await waitFor(() => expect(openedPdfs).toContain("pdfout/main.pdf"))
    // One PDF beside the source, and it is the new one.
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex", "main.pdf"]))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(tabLabels()).toEqual(["main.tex", "main.pdf"])
    expect(screen.getAllByTestId("central-tab")[0]?.getAttribute("data-active")).toBe("true")
    cleanup()
  })

  test("an existing paper with an up-to-date PDF shows it at once without building", async () => {
    const builds: unknown[] = []
    const client = createFakeTrpcClient({
      ...handlers(),
      "files.stat": (input) => statFiles(input, { "main.tex": 1, "build/main.pdf": 2 }),
      "pdf.build": (input) => {
        builds.push(input)
        return { relPath: "build/main.pdf", success: true, log: "" }
      },
    })
    renderEditor(client, "p12", null, null, null)
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex", "main.pdf"]))
    expect(builds).toEqual([])
    cleanup()
  })

  test("Update paper in the top bar starts a write-research agent as a focused tab", async () => {
    const slot = document.createElement("div")
    document.body.append(slot)
    const client = createFakeTrpcClient(handlers())
    renderEditor(client, "p7", null, null, slot)
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex"]))
    const button = within(slot).getByTestId("paper-update")
    // It sits before Sync in the top bar.
    const sync = within(slot).getByTestId("paper-sync")
    expect(button.compareDocumentPosition(sync) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(button)
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex", "Update paper"]))
    expect(started).toEqual([{ projectId: "p7" }])
    const agentTab = screen
      .getAllByTestId("central-tab")
      .find((tab) => tab.getAttribute("data-tab-kind") === "agent")
    expect(agentTab?.getAttribute("data-active")).toBe("true")
    cleanup()
    slot.remove()
  })

  afterEach(() => window.localStorage.clear())

  test("the top bar + menu lists Update paper, can remove it, and an added skill opens as a tab here", async () => {
    const slot = document.createElement("div")
    document.body.append(slot)
    const client = createFakeTrpcClient(handlers())
    renderEditor(client, "p8", null, null, slot)
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex"]))
    const add = within(slot).getByTestId("latex-shortcuts-add")
    // The "+" leads the top bar buttons, before Update paper.
    const update = within(slot).getByTestId("paper-update")
    expect(add.compareDocumentPosition(update) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(add)
    const menu = await screen.findByRole("menu", { name: "Header shortcuts" })
    const item = within(menu).getByRole("menuitemcheckbox", { name: "Update paper" })
    expect(item.getAttribute("aria-checked")).toBe("true")
    fireEvent.click(item)
    await waitFor(() => expect(within(slot).queryByTestId("paper-update")).toBeNull())
    expect(
      JSON.parse(window.localStorage.getItem("pi-lab.latexEditor.headerShortcuts") ?? ""),
    ).toEqual(["sync", "research-diary"])

    fireEvent.click(within(menu).getByRole("button", { name: "Skills" }))
    fireEvent.click(await within(menu).findByRole("menuitemcheckbox", { name: "Review notes" }))
    const skill = await within(slot).findByTestId("latex-shortcut-skill-review-notes")
    await waitFor(() => expect(skill.hasAttribute("disabled")).toBe(false))
    fireEvent.click(skill)
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex", "Review notes"]))
    expect(started).toEqual([{ projectId: "p8", skillSlug: "review-notes", origin: "latex" }])
    cleanup()
    slot.remove()
  })

  test("the top bar + menu lists Update paper and Sync, checked, and Sync can be removed and added back", async () => {
    const slot = document.createElement("div")
    document.body.append(slot)
    renderEditor(createFakeTrpcClient(handlers()), "p9", null, null, slot)
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex"]))
    expect(within(slot).getByTestId("paper-sync")).toBeTruthy()
    fireEvent.click(within(slot).getByTestId("latex-shortcuts-add"))
    const menu = await screen.findByRole("menu", { name: "Header shortcuts" })
    const items = within(menu).getAllByRole("menuitemcheckbox")
    expect(items.map((item) => item.textContent)).toEqual(["Update paper", "Sync"])
    expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual(["true", "true"])

    fireEvent.click(items[1] as HTMLElement)
    await waitFor(() => expect(within(slot).queryByTestId("paper-sync")).toBeNull())
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Sync" }))
    await waitFor(() => expect(within(slot).getByTestId("paper-sync")).toBeTruthy())
    cleanup()
    slot.remove()
  })
})
