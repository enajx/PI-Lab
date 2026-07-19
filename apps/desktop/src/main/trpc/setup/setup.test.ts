import {
  agentCredentials,
  getAgentSettingsOrDefaults,
  getSettingsOrDefaults,
} from "@pi-lab/local-db"
import type { TerminalAgent } from "@pi-lab/shared"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createHarness, type Harness } from "../testHarness"

let harness: Harness
const SAFE_SETUP_AGENTS: TerminalAgent[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    command: process.execPath,
    detect: "node",
  },
  {
    id: "codex",
    label: "Codex",
    command: process.execPath,
    detect: "node",
  },
]

beforeEach(async () => {
  harness = await createHarness(SAFE_SETUP_AGENTS, {
    setupProbe: async ({ command, args }) =>
      command !== "gh" && args[0] === "auth" && args[1] === "status"
        ? {
            code: 0,
            stdout: JSON.stringify({
              loggedIn: true,
              authMethod: "claude.ai",
              email: "researcher@example.test",
              subscriptionType: "Max",
              apiKey: "must-not-cross",
            }),
            stderr: "",
            timedOut: false,
          }
        : args[0] === "login" && args[1] === "status"
          ? {
              code: 0,
              stdout: "Logged in using ChatGPT",
              stderr: "",
              timedOut: false,
            }
          : {
              code: 0,
              stdout: JSON.stringify({
                hosts: {
                  "github.com": [
                    { active: true, state: "success", login: "octo", token: "must-not-cross" },
                  ],
                },
              }),
              stderr: "",
              timedOut: false,
            },
    httpFetch: async () => new Response("[]", { status: 200 }),
  })
})

afterEach(async () => {
  await harness.dispose()
})

describe("setup router", () => {
  test("reports allowlisted harness, GitHub, and Zotero status", async () => {
    const environment = await harness.caller.setup.environment()

    expect(environment.harnesses).toMatchObject([
      {
        id: "claude-code",
        state: "authenticated",
        method: "Claude.ai",
        account: "researcher@example.test",
        plan: "Max",
      },
      { id: "codex", state: "authenticated", method: "ChatGPT" },
    ])
    expect(environment.github).toMatchObject({
      state: "authenticated",
      account: "octo",
      connectivity: "available",
    })
    expect(environment.zotero).toBe("running")
    expect(environment.apiConfigured).toEqual({ "claude-code": false, codex: false })
    expect(JSON.stringify(environment)).not.toContain("must-not-cross")
  })

  test("encrypts API keys before storing them and surfaces only configured presence", async () => {
    await harness.caller.setup.saveApiKey({ agentId: "codex", apiKey: "sk-local-secret" })

    const credential = harness.db.select().from(agentCredentials).get()
    expect(credential?.encryptedValue).not.toContain("sk-local-secret")
    expect(await harness.caller.setup.environment()).toMatchObject({
      apiConfigured: { "claude-code": false, codex: true },
    })
  })

  test("complete persists the Silent default atomically and skip records only completion", async () => {
    await harness.caller.setup.complete({ sound: "silent" })
    expect(getAgentSettingsOrDefaults(harness.db).setupCompleted).toBe(true)
    const notifications = getSettingsOrDefaults(harness.db).notifications
    expect(notifications.agentTurnCompletion.sound).toBe("silent")
    expect(notifications.terminalCompletion.sound).toBe("silent")
    expect(notifications.workflowCompletion.sound).toBe("silent")

    await harness.caller.settings.updateAgents({ setupCompleted: false })
    await harness.caller.settings.updateNotifications({
      agentTurnCompletion: { sound: "chime" },
    })
    await harness.caller.setup.skip()
    expect(getAgentSettingsOrDefaults(harness.db).setupCompleted).toBe(true)
    expect(getSettingsOrDefaults(harness.db).notifications.agentTurnCompletion.sound).toBe("chime")
  })
})
