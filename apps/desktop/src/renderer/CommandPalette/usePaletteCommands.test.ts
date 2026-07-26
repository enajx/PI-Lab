import type { Project } from "@pi-lab/local-db"
import { describe, expect, test, vi } from "vitest"
import type { AddProjectRequest } from "../routes/_shell/components/AddProjectController"
import type { NewFileRequest } from "../routes/_shell/components/NewFileController"
import {
  clearPendingOpenFile,
  readPendingOpenFile,
} from "../routes/_shell/projects/-pendingOpenFile"
import { createAddProjectCommand, createNewFileCommand } from "./usePaletteCommands"

const project: Project = {
  id: "project-added",
  metadata: null,
  agentConfig: null,
  repoPath: "/tmp/project-added",
  name: "Project Added",
  defaultBranch: "main",
  color: null,
  thumbnail: null,
  gradient: null,
  digitalRain: false,
  sortIndex: 0,
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
  lastOpenedAt: 0,
}

describe("Add Project palette command", () => {
  test("dispatches the shared chooser and navigates with the returned project id", () => {
    const requests: AddProjectRequest[] = []
    const navigateToProject = vi.fn()
    const command = createAddProjectCommand((next) => {
      requests.push(next)
    }, navigateToProject)

    expect(command).toMatchObject({
      id: "add-project",
      label: "New/Add Project",
      group: "Projects",
    })

    command.run()
    expect(requests).toHaveLength(1)
    requests[0]?.onAdded(project)

    expect(navigateToProject).toHaveBeenCalledOnce()
    expect(navigateToProject).toHaveBeenCalledWith("project-added")
  })
})

describe("New file palette command", () => {
  test("dispatches the global project/path flow and navigates to the created file", () => {
    const requests: NewFileRequest[] = []
    const navigateToFile = vi.fn()
    const command = createNewFileCommand((next) => {
      requests.push(next)
    }, navigateToFile)

    expect(command).toMatchObject({
      id: "new-file",
      label: "New file",
      group: "Projects",
    })

    command.run()
    expect(requests).toHaveLength(1)
    requests[0]?.onCreated({ projectId: "project-added", relPath: "notes/idea.md" })

    expect(navigateToFile).toHaveBeenCalledOnce()
    expect(navigateToFile).toHaveBeenCalledWith("project-added", "notes/idea.md")
  })

  test("opens an untitled buffer first when the palette runs inside a project", () => {
    const openNewFile = vi.fn()
    const command = createNewFileCommand(openNewFile, vi.fn(), "project-added")
    command.run()

    expect(openNewFile).not.toHaveBeenCalled()
    expect(readPendingOpenFile("project-added")).toMatchObject({ kind: "new" })
    clearPendingOpenFile("project-added")
  })
})
