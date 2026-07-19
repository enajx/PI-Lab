import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type PiLabDatabase, runMigrations } from "./migrate"
import { agentSessions, automationRuns, automations, projects, workspaces } from "./tables"

// Behavioral tests against a migrated temp DB: insert rows through Drizzle and
// assert the constraints that live in SQL (foreign keys + the partial unique
// index) actually fire.

let dataDir: string
let db: PiLabDatabase
let close: () => void

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "pi-lab-localdb-tables-"))
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

describe("interactive activity persistence", () => {
  it("round-trips a durable agent session and its workflow-run target", async () => {
    const projectId = await makeProject("activity")
    const [workspace] = await db
      .insert(workspaces)
      .values({
        projectId,
        kind: "branch",
        name: "main",
        branch: "main",
      })
      .returning()
    if (!workspace) throw new Error("workspace insert returned nothing")

    const [automation] = await db
      .insert(automations)
      .values({
        projectId,
        name: "Morning check",
        agentId: "codex",
        prompt: "Check the project",
        recurrenceRule: "FREQ=DAILY",
        timezone: "Europe/Copenhagen",
      })
      .returning()
    if (!automation) throw new Error("automation insert returned nothing")

    const [run] = await db
      .insert(automationRuns)
      .values({
        automationId: automation.id,
        scheduledFor: Date.now(),
        state: "running",
        workspaceId: workspace.id,
        sessionId: "pty-activity",
        launchedAt: Date.now(),
      })
      .returning()
    if (!run) throw new Error("automation run insert returned nothing")

    await db.insert(agentSessions).values({
      sessionId: "pty-activity",
      projectId,
      workspaceId: workspace.id,
      agentId: "codex",
      workflowRunId: run.id,
      state: "waiting",
      turnArmed: true,
      waitingReason: "permission",
      waitingSince: Date.now(),
    })

    const stored = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.sessionId, "pty-activity"))
      .get()
    expect(stored).toMatchObject({
      projectId,
      workspaceId: workspace.id,
      agentId: "codex",
      workflowRunId: run.id,
      state: "waiting",
      turnArmed: true,
      waitingReason: "permission",
    })
  })

  it("keeps legacy launched workflow rows readable alongside completed rows", async () => {
    const projectId = await makeProject("run-states")
    const [automation] = await db
      .insert(automations)
      .values({
        projectId,
        name: "State check",
        agentId: "claude-code",
        recurrenceRule: "FREQ=DAILY",
        timezone: "UTC",
      })
      .returning()
    if (!automation) throw new Error("automation insert returned nothing")

    await db.insert(automationRuns).values([
      {
        automationId: automation.id,
        scheduledFor: 1,
        state: "launched",
        launchedAt: 1,
      },
      {
        automationId: automation.id,
        scheduledFor: 2,
        state: "completed",
        launchedAt: 2,
        completedAt: 3,
      },
    ])

    const rows = db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.automationId, automation.id))
      .all()
    expect(rows.map(({ state }) => state)).toEqual(["launched", "completed"])
    expect(rows[1]?.completedAt).toBe(3)
  })
})
