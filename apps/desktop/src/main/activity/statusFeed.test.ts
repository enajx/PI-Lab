import { projects, runMigrations } from "@pi-lab/local-db"
import { eq } from "drizzle-orm"
import { expect, test, vi } from "vitest"
import type { LiveAgentStatus } from "../../shared/agentStatus"
import { ActivityRegistry } from "./registry"
import { ActivityStatusFeed } from "./statusFeed"

test("status subscribers get initial state, changed fields and names without output fanout", () => {
  const { db, sqlite } = runMigrations(":memory:")
  const registry = new ActivityRegistry({
    clock: { now: () => 1000 },
    scheduler: { schedule: () => ({ cancel: () => {} }) },
  })
  db.insert(projects).values({ id: "p1", repoPath: "/repo", name: "Original" }).run()
  registry.register({
    sessionId: "s1",
    projectId: "p1",
    workspaceId: null,
    agentId: "codex",
    workflowRunId: null,
    turnArmed: true,
  })
  const feed = new ActivityStatusFeed(db, registry)
  const emitted: LiveAgentStatus[][] = []
  const select = vi.spyOn(db, "select")
  const stop = feed.subscribe((sessions) => emitted.push(sessions))
  expect(emitted[0]).toEqual([
    {
      sessionId: "s1",
      projectId: "p1",
      projectName: "Original",
      agentId: "codex",
      state: "working",
    },
  ])
  for (let i = 0; i < 1000; i += 1) registry.userSubmitted("s1")
  expect(emitted).toHaveLength(1)
  expect(select).toHaveBeenCalledTimes(1)

  db.update(projects).set({ name: "Renamed" }).where(eq(projects.id, "p1")).run()
  feed.projectsChanged()
  expect(emitted.at(-1)?.[0]?.projectName).toBe("Renamed")
  registry.processExited("s1", null)
  expect(emitted.at(-1)).toEqual([])
  expect(emitted).toHaveLength(3)
  stop()
  registry.register({
    sessionId: "s2",
    projectId: "p1",
    workspaceId: null,
    agentId: "codex",
    workflowRunId: null,
    turnArmed: true,
  })
  expect(emitted).toHaveLength(3)
  const second: LiveAgentStatus[][] = []
  feed.subscribe((sessions) => second.push(sessions))()
  expect(second[0]?.[0]?.sessionId).toBe("s2")
  select.mockRestore()
  registry.dispose()
  sqlite.close()
})
