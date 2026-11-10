import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createHarness, type Harness } from "../../testHarness"

let h: Harness

beforeEach(async () => {
  h = await createHarness()
})

afterEach(async () => {
  await h.dispose()
})

const TABLE = `# Experiments

| id | date | question | status | notes |
|----|------|----------|--------|-------|
| a | 2026-10-30 | q | RUNNING | — |
| b | 2026-10-30 | q | COMPLETED | — |
| c | 2026-10-30 | q | COMPLETED | — |
| d | 2026-10-30 | q | FAILED: node went down (NODE_FAIL) | — |
| e | 2026-10-30 | q | ABORTED | — |
| f | 2026-10-30 | q | PLANNED | — |
| g | 2026-10-30 | q | PLANNED | — |

## Findings

| id | date | question | one-line finding | file |
|----|------|----------|------------------|------|
| ... | ... | ... | ... | ... |
`

describe("science.experiments.status", () => {
  test("counts the EXPERIMENTS.md status column into running, finished, failed and other", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await writeFile(join(h.repoDir, "EXPERIMENTS.md"), TABLE)

    const status = await h.caller.science.experiments.status({
      projectId: project.id,
      source: { kind: "experiments-md", relPath: "EXPERIMENTS.md" },
    })

    expect(status).toEqual({
      found: true,
      relPath: "EXPERIMENTS.md",
      running: 1,
      finished: 2,
      failed: 1,
      other: [
        { status: "ABORTED", count: 1 },
        { status: "PLANNED", count: 2 },
      ],
    })
  })

  test("reads the file at the configured path inside the project", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await mkdir(join(h.repoDir, "notes"))
    await writeFile(join(h.repoDir, "notes", "runs.md"), TABLE)

    const status = await h.caller.science.experiments.status({
      projectId: project.id,
      source: { kind: "experiments-md", relPath: "notes/runs.md" },
    })

    expect(status).toMatchObject({ found: true, relPath: "notes/runs.md", running: 1 })
  })

  test("says the file is missing instead of reporting zero runs", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })

    const status = await h.caller.science.experiments.status({
      projectId: project.id,
      source: { kind: "experiments-md", relPath: "EXPERIMENTS.md" },
    })

    expect(status).toEqual({ found: false, relPath: "EXPERIMENTS.md" })
  })

  test("rejects a path outside the project", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    await expect(
      h.caller.science.experiments.status({
        projectId: project.id,
        source: { kind: "experiments-md", relPath: "../EXPERIMENTS.md" },
      }),
    ).rejects.toThrow()
  })
})
