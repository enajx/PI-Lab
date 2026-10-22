import { agentSessions } from "@pi-lab/local-db"
import { eq } from "drizzle-orm"
import { afterEach, expect, test } from "vitest"
import { createHarness, FAKE_AGENT, type Harness } from "../testHarness"

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
})

/** Real SQLite → sessions.start → daemon → PTY; the credential-free CLI prints argv. */
test.each([
  [
    "codex",
    ["--model", "custom model", "--config", 'model_reasoning_effort="high"', "test prompt"],
  ],
  ["claude-code", ["--model", "custom model", "--effort", "high", "test prompt"]],
])("new %s sessions receive saved provider launch defaults", async (id, expected) => {
  harness = await createHarness(
    [
      {
        id,
        label: id,
        command: process.execPath,
        detect: "node",
        defaultArgs: [
          "-e",
          "process.stdout.write('ARGV:'+JSON.stringify(process.argv.slice(1))+'\\n');process.stdin.resume()",
          "--",
        ],
      },
    ],
    { git: false },
  )
  await harness.caller.settings.updateAgents({
    launchDefaults: { [id]: { model: "custom model", effort: "high" } },
  })
  const project = await harness.caller.projects.open({ path: harness.repoDir })
  const session = await harness.caller.sessions.start({
    projectId: project.id,
    agentId: id,
    prompt: "test prompt",
  })
  let output = ""
  const stream = await harness.caller.terminal.onData({ sessionId: session.sessionId })
  const subscription = stream.subscribe({
    next: (event) => {
      if (event.type === "data") output += event.chunk
    },
  })
  await expect.poll(() => output, { timeout: 5000 }).toContain(`ARGV:${JSON.stringify(expected)}`)
  subscription.unsubscribe()
})

test("Auto-research with no project override uses the persisted Settings agent", async () => {
  harness = await createHarness([FAKE_AGENT])
  await harness.caller.settings.updateAgents({ defaultAgentId: FAKE_AGENT.id })
  const project = await harness.caller.projects.open({ path: harness.repoDir })
  const launched = await harness.caller.sessions.startAutoResearch({ projectId: project.id })
  expect(
    harness.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.sessionId, launched.sessionId))
      .get()?.agentId,
  ).toBe(FAKE_AGENT.id)
})
