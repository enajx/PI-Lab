import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projects, runMigrations } from "@pi-lab/local-db"
import { eq } from "drizzle-orm"
import { expect, test } from "vitest"
import { readProjectAgentConfig } from "./projectConfig"

test("both-mode reads prefer the repository without rewriting app state or its timestamp", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lab-agent-config-"))
  const { db, sqlite } = runMigrations(join(root, "local.db"))
  try {
    await mkdir(join(root, ".pi-lab"))
    await writeFile(join(root, ".pi-lab/config.json"), JSON.stringify({ agentId: "repo-choice" }))
    const project = db
      .insert(projects)
      .values({
        name: "Repo",
        repoPath: root,
        agentConfig: { agentId: "app-choice" },
        updatedAt: 1,
      })
      .returning()
      .get()
    expect(await readProjectAgentConfig(project, "both")).toEqual({ agentId: "repo-choice" })
    expect(db.select().from(projects).where(eq(projects.id, project.id)).get()).toEqual(project)
  } finally {
    sqlite.close()
    await rm(root, { recursive: true, force: true })
  }
})
