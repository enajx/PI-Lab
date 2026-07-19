import type { TerminalAgent } from "@pi-lab/shared"
import { describe, expect, test, vi } from "vitest"
import type { SetupProbe } from "./probe"
import { detectGitHub, detectHarnesses } from "./status"

const CATALOG: TerminalAgent[] = [
  { id: "claude-code", label: "Claude Code", command: "claude", detect: "claude" },
  { id: "codex", label: "Codex", command: "codex", detect: "codex" },
  { id: "future-agent", label: "Future", command: "future", detect: "future" },
]

test("honors overrides, probes only Claude/Codex, and returns allowlisted fields", async () => {
  const probe = vi.fn<SetupProbe>(async ({ command }) =>
    command.includes("claude")
      ? {
          code: 0,
          stdout: JSON.stringify({
            loggedIn: true,
            authMethod: "oauth",
            email: "researcher@example.test",
            subscriptionType: "Max",
            accessToken: "must-not-leak",
          }),
          stderr: "sk-secret-must-not-leak",
          timedOut: false,
        }
      : {
          code: 0,
          stdout: "Logged in using ChatGPT",
          stderr: "",
          timedOut: false,
        },
  )
  const resolveExecutable = vi.fn(async (candidate: string) => `/resolved/${candidate}`)

  const statuses = await detectHarnesses(
    CATALOG,
    { "claude-code": "/custom/claude" },
    { resolveExecutable, probe, environment: { PATH: "/resolved" } },
  )

  expect(resolveExecutable.mock.calls.map(([candidate]) => candidate)).toEqual([
    "/custom/claude",
    "codex",
  ])
  expect(probe).toHaveBeenCalledTimes(2)
  expect(statuses).toEqual([
    {
      id: "claude-code",
      label: "Claude Code",
      executable: "/resolved//custom/claude",
      state: "authenticated",
      method: "OAuth",
      account: "researcher@example.test",
      plan: "Max",
    },
    {
      id: "codex",
      label: "Codex",
      executable: "/resolved/codex",
      state: "authenticated",
      method: "ChatGPT",
    },
  ])
  expect(JSON.stringify(statuses)).not.toContain("accessToken")
  expect(JSON.stringify(statuses)).not.toContain("sk-secret")
})

describe("explicit setup states", () => {
  test("invalid override stays missing without a PATH fallback or probe", async () => {
    const probe = vi.fn<SetupProbe>()
    const resolveExecutable = vi.fn(async () => null)

    await expect(
      detectHarnesses(
        CATALOG.slice(0, 1),
        { "claude-code": "/missing/claude" },
        {
          resolveExecutable,
          probe,
          environment: {},
        },
      ),
    ).resolves.toEqual([
      {
        id: "claude-code",
        label: "Claude Code",
        executable: "/missing/claude",
        state: "missing",
      },
    ])
    expect(resolveExecutable).toHaveBeenCalledWith("/missing/claude")
    expect(probe).not.toHaveBeenCalled()
  })

  test("maps logged-out and timed-out harness checks without raw output", async () => {
    const probe = vi
      .fn<SetupProbe>()
      .mockResolvedValueOnce({
        code: 1,
        stdout: JSON.stringify({ loggedIn: false, authMethod: "none", secret: "hidden" }),
        stderr: "",
        timedOut: false,
      })
      .mockResolvedValueOnce({
        code: null,
        stdout: "",
        stderr: "private filesystem detail",
        timedOut: true,
      })

    const statuses = await detectHarnesses(
      CATALOG,
      {},
      {
        resolveExecutable: async (value) => value,
        probe,
        environment: {},
      },
    )

    expect(statuses).toEqual([
      {
        id: "claude-code",
        label: "Claude Code",
        executable: "claude",
        state: "unauthenticated",
        method: "None",
      },
      {
        id: "codex",
        label: "Codex",
        executable: "codex",
        state: "error",
        message: "Status check timed out",
      },
    ])
    expect(JSON.stringify(statuses)).not.toContain("private filesystem")
    expect(JSON.stringify(statuses)).not.toContain("hidden")
  })

  test("recognizes the current Codex login result when it is written to stderr", async () => {
    const statuses = await detectHarnesses(
      CATALOG.slice(1, 2),
      {},
      {
        resolveExecutable: async (value) => value,
        probe: async () => ({
          code: 0,
          stdout: "",
          stderr: "Logged in using ChatGPT",
          timedOut: false,
        }),
        environment: {},
      },
    )

    expect(statuses).toEqual([
      {
        id: "codex",
        label: "Codex",
        executable: "codex",
        state: "authenticated",
        method: "ChatGPT",
      },
    ])
  })

  test("drops secret-looking values even when they occupy account, method, or plan fields", async () => {
    const [status] = await detectHarnesses(
      CATALOG.slice(0, 1),
      {},
      {
        resolveExecutable: async (value) => value,
        probe: async () => ({
          code: 0,
          stdout: JSON.stringify({
            loggedIn: true,
            authMethod: "sk-secret-method",
            email: "sk-secret-account",
            subscriptionType: "sk-secret-plan",
          }),
          stderr: "",
          timedOut: false,
        }),
        environment: {},
      },
    )

    expect(status).toEqual({
      id: "claude-code",
      label: "Claude Code",
      executable: "claude",
      state: "authenticated",
    })
    expect(JSON.stringify(status)).not.toContain("sk-secret")
  })
})

describe("GitHub status", () => {
  test("parses only the active successful account", async () => {
    const result = await detectGitHub({
      resolveExecutable: async () => "/opt/bin/gh",
      probe: async () => ({
        code: 0,
        stdout: JSON.stringify({
          hosts: {
            "github.com": [
              { active: false, state: "success", login: "old" },
              {
                active: true,
                state: "success",
                login: "researcher",
                token: "must-not-leak",
              },
            ],
          },
        }),
        stderr: "",
        timedOut: false,
      }),
      environment: {},
    })

    expect(result).toEqual({
      executable: "/opt/bin/gh",
      state: "authenticated",
      account: "researcher",
      connectivity: "available",
    })
    expect(JSON.stringify(result)).not.toContain("token")
  })

  test("reports a missing optional gh without invoking it", async () => {
    const probe = vi.fn<SetupProbe>()
    await expect(
      detectGitHub({
        resolveExecutable: async () => null,
        probe,
        environment: {},
      }),
    ).resolves.toEqual({
      executable: "gh",
      state: "missing",
      connectivity: "unchecked",
    })
    expect(probe).not.toHaveBeenCalled()
  })
})
