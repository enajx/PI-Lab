// @vitest-environment jsdom

import { beforeEach, expect, test } from "vitest"
import { WorkspaceRecoveryStore } from "../routes/_shell/projects/-workspaceRecovery"
import {
  alphaProjectsHaveUnsavedWork,
  clearAlphaLocalPreferences,
  clearAlphaProjectUiState,
} from "./resetAlphaPreferences"

beforeEach(() => window.localStorage.clear())

test("clears Alpha preferences while keeping project workspace recovery", () => {
  window.localStorage.setItem("pi-lab.theme", "dark")
  window.localStorage.setItem("pi-lab.shortcuts", "{}")
  window.localStorage.setItem("pi-lab.projectWorkspace.v2.project-1", "saved tabs")
  window.localStorage.setItem("other-app.preference", "keep")

  clearAlphaLocalPreferences(window.localStorage)

  expect(window.localStorage.getItem("pi-lab.theme")).toBeNull()
  expect(window.localStorage.getItem("pi-lab.shortcuts")).toBeNull()
  expect(window.localStorage.getItem("pi-lab.projectWorkspace.v2.project-1")).toBe("saved tabs")
  expect(window.localStorage.getItem("other-app.preference")).toBe("keep")
})

test("project-list reset clears project UI state but keeps appearance", () => {
  window.localStorage.setItem("pi-lab.theme", "dark")
  window.localStorage.setItem("pi-lab.projectWorkspace.v2.project-1", "tabs")
  window.localStorage.setItem("pi-lab.projectWorkspace.v2.old-project", "older draft")
  window.localStorage.setItem("pi-lab.sidebar.projectOrder", "project-1")

  clearAlphaProjectUiState(window.localStorage, ["project-1"])

  expect(window.localStorage.getItem("pi-lab.theme")).toBe("dark")
  expect(window.localStorage.getItem("pi-lab.projectWorkspace.v2.project-1")).toBeNull()
  expect(window.localStorage.getItem("pi-lab.projectWorkspace.v2.old-project")).toBe("older draft")
  expect(window.localStorage.getItem("pi-lab.sidebar.projectOrder")).toBeNull()
})

test("project-list reset refuses recovered drafts and allows saved files", () => {
  const recovery = new WorkspaceRecoveryStore(window.localStorage)
  const state = {
    buffers: [
      {
        relPath: "notes.md",
        content: "unsaved",
        savedContent: "saved",
        baseline: { mtimeMs: 1, size: 5 },
        externalChange: false,
        epoch: 0,
      },
    ],
    activeRelPath: "notes.md",
    sessions: [],
    active: { type: "file" as const, relPath: "notes.md" },
    belowEditorRun: null,
  }
  recovery.write("project-1", state)
  expect(alphaProjectsHaveUnsavedWork(["project-1"], recovery)).toBe(true)

  recovery.write("project-1", {
    ...state,
    buffers: state.buffers.map((buffer) => ({ ...buffer, content: "saved" })),
  })
  expect(alphaProjectsHaveUnsavedWork(["project-1"], recovery)).toBe(false)
  recovery.dispose()
})
