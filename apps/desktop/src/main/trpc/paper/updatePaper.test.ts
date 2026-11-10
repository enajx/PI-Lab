// Integration tests for `paper.startUpdate` (the LaTeX Editor's Update paper
// button): the real router, SQLite, an in-process pty-daemon, and a fake agent
// that prints the prompt it was started with.
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { agentSessions } from "@pi-lab/local-db"
import type { TerminalAgent } from "@pi-lab/shared"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, expect, test } from "vitest"
import { createHarness, type Harness } from "../testHarness"
import { findSkill } from "../workflows/planResearchSkill"

/** Prints its first argument (the prompt) and stays alive. */
const PROMPT_AGENT: TerminalAgent = {
  id: "prompt-agent",
  label: "Prompt Agent",
  command: process.execPath,
  detect: "node",
  defaultArgs: [
    "-e",
    "process.stdout.write('PROMPT:'+(process.argv[1] ?? 'NO-PROMPT')+':END');setInterval(()=>{},1000)",
  ],
}

let h: Harness
let projectId: string

beforeEach(async () => {
  h = await createHarness([PROMPT_AGENT])
  projectId = (await h.caller.projects.open({ path: h.repoDir })).id
  await h.caller.agents.setProjectChoice({ projectId, agentId: PROMPT_AGENT.id })
})

afterEach(async () => {
  await h.dispose()
})

/** Collect a session's terminal output until it contains `marker`. */
async function outputUntil(sessionId: string, marker: string): Promise<string> {
  const chunks: string[] = []
  const stream = await h.caller.terminal.onData({ sessionId })
  const sub = stream.subscribe({
    next: (event) => {
      if (event.type === "data") chunks.push(event.chunk)
    },
  })
  const started = Date.now()
  while (!chunks.join("").includes(marker)) {
    if (Date.now() - started > 10_000) throw new Error(`No ${marker} in: ${chunks.join("")}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  sub.unsubscribe()
  return chunks.join("").replace(/\r?\n/g, "")
}

test("Update paper starts a LaTeX Editor agent with the write-research skill and the paper's main .tex", async () => {
  const paperDir = join(h.repoDir, "paper")
  await mkdir(paperDir)
  await writeFile(join(paperDir, "main.tex"), "\\documentclass{article}\n")
  await h.caller.paper.link({ projectId, dir: paperDir, rootChoice: null })
  const skillDir = join(h.skillsHomeDir, ".agents", "skills", "write-research")
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, "SKILL.md"), "# Write research\nUSER SKILL TEXT\n")

  const result = await h.caller.paper.startUpdate({ projectId })
  expect(result.agentId).toBe(PROMPT_AGENT.id)
  const row = h.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.sessionId, result.sessionId))
    .get()
  expect(row?.origin).toBe("latex")
  const output = await outputUntil(result.sessionId, ":END")
  expect(output).toContain("write-research")
  expect(output).toContain(join(skillDir, "SKILL.md"))
  expect(output).toContain(paperDir)
  expect(output).toContain("main.tex")
})

test("Update paper with no paper folder starts no agent", async () => {
  await expect(h.caller.paper.startUpdate({ projectId })).rejects.toThrow(/paper folder/i)
  expect(await h.caller.terminal.list()).toEqual([])
})

test("PI Lab ships the write-research placeholder skill", async () => {
  const bundled = join(__dirname, "..", "..", "..", "..", "resources", "skills")
  const skill = await findSkill("write-research", "Write research", "/missing", "/missing", bundled)
  expect(skill.path).toBe(join(bundled, "write-research", "SKILL.md"))
  expect(skill.content).toContain("placeholder")
})
