import { beforeEach, describe, expect, test } from "vitest"
import { RECOVERY_PREFIX, WorkspaceRecoveryStore } from "./-workspaceRecovery"
import {
  readProjectWorkspaceState,
  workspaceRecovery,
  writeProjectWorkspaceState,
  writeProjectWorkspaceViewState,
} from "./-workspaceState"

describe("project workspace restoration preference", () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  test("turning tab restoration off leaves persistent project-view choices intact", () => {
    const projectId = `restore-pref-${Math.random()}`
    writeProjectWorkspaceState(projectId, {
      buffers: [
        {
          relPath: "notes.md",
          content: "# Draft",
          savedContent: "# Saved",
          baseline: { mtimeMs: 1, size: 7 },
          externalChange: false,
          epoch: 0,
        },
      ],
      activeRelPath: "notes.md",
      sessions: [
        {
          id: "pane-1",
          kind: "terminal",
          sessionId: "terminal-1",
          label: "Terminal",
          launch: { type: "terminal" },
        },
      ],
      active: { type: "session", id: "pane-1" },
      belowEditorRun: null,
    })
    writeProjectWorkspaceViewState(projectId, {
      rightSidebarCollapsed: true,
      rightSidebarActiveId: "research",
      pinnedPanels: ["PROJECT.md"],
      filesPanelOpen: true,
    })

    expect(readProjectWorkspaceState(projectId, false)?.buffers[0]?.content).toBe("# Draft")
    workspaceRecovery().flush()
    const restored = new WorkspaceRecoveryStore(window.localStorage).read(projectId, false)

    expect(restored).toMatchObject({
      buffers: [],
      activeRelPath: null,
      sessions: [],
      active: null,
      rightSidebarCollapsed: true,
      rightSidebarActiveId: "research",
      pinnedPanels: ["PROJECT.md"],
      filesPanelOpen: true,
    })
  })

  test("a project saved without its own left Files column value keeps none (follows the global default)", () => {
    const projectId = `legacy-files-panel-${Math.random()}`
    writeProjectWorkspaceState(projectId, {
      buffers: [],
      activeRelPath: null,
      sessions: [],
      active: null,
      belowEditorRun: null,
    })
    workspaceRecovery().flush()
    const key = `${RECOVERY_PREFIX}${projectId}`
    const stored = JSON.parse(window.localStorage.getItem(key) ?? "null") as Record<string, unknown>
    delete stored.filesPanelOpen
    window.localStorage.setItem(key, JSON.stringify(stored))

    const restored = new WorkspaceRecoveryStore(window.localStorage).read(projectId, true)
    expect(restored).toBeDefined()
    expect(restored?.filesPanelOpen).toBeUndefined()
  })
})
