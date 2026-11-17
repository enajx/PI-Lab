import type { TerminalAgent } from "@pi-lab/shared"
import { afterEach, beforeEach, expect, test } from "vitest"
import { createHarness, type Harness } from "../testHarness"

/**
 * Real PTY launches through `sessions.start`. The catalog ids are the real
 * provider ids, but each "agent" is node printing the key variables and its
 * argv, so no provider CLI or real key is needed (stubbed agents).
 */
const PRINT_KEYS =
  "process.stdout.write('KEYS:'+JSON.stringify({a:process.env.ANTHROPIC_API_KEY??null,c:process.env.CODEX_API_KEY??null,o:process.env.OPENAI_API_KEY??null,g:process.env.GEMINI_API_KEY??null,argv:process.argv.slice(1)})+':END');setInterval(()=>{},1000)"

const agentWithId = (id: string): TerminalAgent => ({
  id,
  label: id,
  command: process.execPath,
  detect: "node",
  defaultArgs: ["-e", PRINT_KEYS, "--"],
})

let h: Harness
let projectId: string

beforeEach(async () => {
  h = await createHarness([agentWithId("claude-code"), agentWithId("codex"), agentWithId("gemini")])
  projectId = (await h.caller.projects.open({ path: h.repoDir })).id
})

afterEach(async () => {
  await h.dispose()
})

async function launchAndReadKeys(agentId: string): Promise<{
  a: string | null
  c: string | null
  o: string | null
  g: string | null
  argv: string[]
}> {
  const { sessionId } = await h.caller.sessions.start({ origin: "project", projectId, agentId })
  const chunks: string[] = []
  const stream = await h.caller.terminal.onData({ sessionId })
  const sub = stream.subscribe({
    next: (event) => {
      if (event.type === "data") chunks.push(event.chunk)
    },
  })
  const deadline = Date.now() + 4000
  let match: RegExpMatchArray | null = null
  while (!match && Date.now() < deadline) {
    match = chunks.join("").match(/KEYS:(.*?):END/s)
    if (!match) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  sub.unsubscribe()
  await h.caller.terminal.kill({ sessionId })
  if (!match?.[1]) throw new Error(`No key output from ${agentId}`)
  return JSON.parse(match[1].replace(/\r?\n/g, ""))
}

/** The session-only agy settings passed with `--settings`. */
function geminiSettings(argv: string[]): Record<string, unknown> {
  const value = argv[argv.indexOf("--settings") + 1]
  return value ? JSON.parse(value) : {}
}

test("API key picked: the saved key is passed to Claude, Codex and Gemini launches", async () => {
  await h.caller.setup.saveApiKey({ agentId: "claude-code", apiKey: "test-anthropic" })
  await h.caller.setup.saveApiKey({ agentId: "codex", apiKey: "test-openai" })
  await h.caller.setup.saveApiKey({ agentId: "gemini", apiKey: "test-gemini" })
  await h.caller.settings.updateAgents({
    launchDefaults: {
      "claude-code": { authMethod: "api-key" },
      codex: { authMethod: "api-key" },
      gemini: { authMethod: "api-key" },
    },
  })

  expect(await launchAndReadKeys("claude-code")).toMatchObject({ a: "test-anthropic" })
  expect(await launchAndReadKeys("codex")).toMatchObject({ c: "test-openai", o: "test-openai" })
  const gemini = await launchAndReadKeys("gemini")
  expect(gemini.g).toBe("test-gemini")
  expect(geminiSettings(gemini.argv)).toMatchObject({ modelProvider: "gemini" })
})

test("Subscription picked (or nothing picked): a saved key is not passed", async () => {
  await h.caller.setup.saveApiKey({ agentId: "claude-code", apiKey: "test-anthropic" })
  await h.caller.setup.saveApiKey({ agentId: "gemini", apiKey: "test-gemini" })
  await h.caller.settings.updateAgents({
    launchDefaults: { "claude-code": { authMethod: "subscription" } },
  })

  const claude = await launchAndReadKeys("claude-code")
  expect(claude.a).not.toBe("test-anthropic")
  const gemini = await launchAndReadKeys("gemini")
  expect(gemini.g).not.toBe("test-gemini")
  expect(geminiSettings(gemini.argv)).not.toHaveProperty("modelProvider")
})

test("API key picked but no key saved: the launch fails with a clear message", async () => {
  await h.caller.settings.updateAgents({ launchDefaults: { codex: { authMethod: "api-key" } } })
  await expect(
    h.caller.sessions.start({ origin: "project", projectId, agentId: "codex" }),
  ).rejects.toThrow(/no API key is saved/i)
})
