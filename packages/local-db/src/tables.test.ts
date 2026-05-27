import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runMigrations, type SkipperDatabase } from "./migrate"
import { projects, workspaces } from "./tables"

// Behavioral tests against a migrated temp DB: insert rows through Drizzle and
// assert the constraints that live in SQL (foreign keys + the partial unique
// index) actually fire.

let dataDir: string
let db: SkipperDatabase
let close: () => void

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "skipper-localdb-tables-"))
  const result = runMigrations(join(dataDir, "local.db"))
  db = result.db
  close = () => result.sqlite.close()
})

afterEach(() => {
  close()
  rmSync(dataDir, { recursive: true, force: true })
})

async function makeProject(name = "demo"): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({ repoPath: join(dataDir, "repos", name), name })
    .returning({ id: projects.id })
  if (!row) throw new Error("project insert returned nothing")
  return row.id
}

describe("workspaces partial unique index", () => {
  it("allows one branch workspace per project", async () => {
    const projectId = await makeProject("solo")
    await expect(
      db.insert(workspaces).values({
        projectId,
        kind: "branch",
        name: "main",
        branch: "main",
      }),
    ).resolves.toBeDefined()
  })

  it("rejects a second branch workspace in the same project", async () => {
    const projectId = await makeProject("dupe")
    await db.insert(workspaces).values({
      projectId,
      kind: "branch",
      name: "main",
      branch: "main",
    })

    await expect(
      db.insert(workspaces).values({
        projectId,
        kind: "branch",
        name: "second",
        branch: "develop",
      }),
    ).rejects.toThrow(/unique/i)
  })

  it("allows many worktree workspaces alongside one branch workspace", async () => {
    const projectId = await makeProject("mixed")
    await db.insert(workspaces).values({
      projectId,
      kind: "branch",
      name: "main",
      branch: "main",
    })
    await db.insert(workspaces).values([
      { projectId, kind: "worktree", name: "feat-a", branch: "feat/a" },
      { projectId, kind: "worktree", name: "feat-b", branch: "feat/b" },
    ])

    const rows = await db.select().from(workspaces)
    expect(rows).toHaveLength(3)
  })

  it("scopes the constraint per project (two projects may each have a branch ws)", async () => {
    const a = await makeProject("proj-a")
    const b = await makeProject("proj-b")
    await db
      .insert(workspaces)
      .values({ projectId: a, kind: "branch", name: "main", branch: "main" })
    await expect(
      db.insert(workspaces).values({ projectId: b, kind: "branch", name: "main", branch: "main" }),
    ).resolves.toBeDefined()
  })
})
