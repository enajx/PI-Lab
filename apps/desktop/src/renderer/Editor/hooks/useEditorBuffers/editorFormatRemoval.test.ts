import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "vitest"
import { createHarness } from "../../../../main/trpc/testHarness"
import { createFakeTrpcClient } from "../../../test/fakeTrpcClient"
import type { RouterInputs } from "../../../trpc/types"
import { type BufferAccess, liveBuffer, saveBuffer } from "./bufferOperations"

/** Real SQLite, routers and disk I/O; the injected formatter removes the real saved file. */
test("formatter removal preserves editor draft through the real file-read boundary", async () => {
  const h = await createHarness(undefined, {
    pyToolsExec: async ({ cwd }) => {
      await rm(join(cwd, "main.py"))
      return { stdout: "1 file reformatted\n", stderr: "", code: 0, notFound: false }
    },
  })
  try {
    const project = await h.caller.projects.open({ path: h.repoDir })
    const workspace = await h.caller.workspaces.ensureMain({ projectId: project.id })
    await writeFile(join(h.repoDir, "main.py"), "old")
    const baseline = await h.caller.files.stat({ workspaceId: workspace.id, relPath: "main.py" })
    let buffers = [
      liveBuffer({
        relPath: "main.py",
        content: "draft",
        savedContent: "old",
        baseline,
        externalChange: false,
        epoch: 0,
      }),
    ]
    let error: string | null = null
    let savedNotifications = 0
    const access: BufferAccess = {
      read: () => buffers,
      update: (update) => {
        buffers = update(buffers)
      },
      current: () => buffers[0],
      reportError: (message) => {
        error = message
      },
      formatOnSave: () => true,
      onSaved: () => {
        savedNotifications += 1
      },
    }
    const client = createFakeTrpcClient({
      "files.stat": (input) => h.caller.files.stat(input as RouterInputs["files"]["stat"]),
      "files.write": (input) => h.caller.files.write(input as RouterInputs["files"]["write"]),
      "files.read": (input) => h.caller.files.read(input as RouterInputs["files"]["read"]),
      "diagnostics.format": (input) =>
        h.caller.diagnostics.format(input as RouterInputs["diagnostics"]["format"]),
    })
    expect(await saveBuffer(access, client, workspace.id, "main.py", false)).toBe(false)
    expect(buffers[0]).toMatchObject({
      content: "draft",
      savedContent: "old",
      baseline,
      externalChange: true,
    })
    expect(savedNotifications).toBe(0)
    expect(error).toMatch(/missing|removed|disappeared/i)
    expect(
      await h.caller.files.read({ workspaceId: workspace.id, relPath: "main.py" }),
    ).toMatchObject({ status: "missing" })
  } finally {
    await h.dispose()
  }
})
