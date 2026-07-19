import type { TerminalAgent } from "@pi-lab/shared"
import type { AgentExecutableResolver } from "../agents/executable"
import type { SetupProbe, SetupProbeOutput } from "./probe"

export type SetupConnectionState = "missing" | "authenticated" | "unauthenticated" | "error"

export interface HarnessSetupStatus {
  id: "claude-code" | "codex"
  label: string
  executable: string
  state: SetupConnectionState
  method?: string
  account?: string
  plan?: string
  message?: string
}

export interface GitHubSetupStatus {
  executable: string
  state: SetupConnectionState
  account?: string
  connectivity: "available" | "unavailable" | "unchecked"
  message?: string
}

export interface SetupStatusDependencies {
  resolveExecutable: AgentExecutableResolver
  probe: SetupProbe
  environment: Record<string, string>
}

const SUPPORTED_HARNESS_IDS = new Set(["claude-code", "codex"])

/** Detect only the two v1 production harnesses; test/future catalog entries stay out of setup. */
export async function detectHarnesses(
  catalog: readonly TerminalAgent[],
  overrides: Record<string, string>,
  dependencies: SetupStatusDependencies,
): Promise<HarnessSetupStatus[]> {
  return Promise.all(
    catalog
      .filter((agent): agent is TerminalAgent & { id: "claude-code" | "codex" } =>
        SUPPORTED_HARNESS_IDS.has(agent.id),
      )
      .map((agent) => detectHarness(agent, overrides[agent.id], dependencies)),
  )
}

async function detectHarness(
  agent: TerminalAgent & { id: "claude-code" | "codex" },
  override: string | undefined,
  dependencies: SetupStatusDependencies,
): Promise<HarnessSetupStatus> {
  const candidate = override?.trim() || agent.command
  const executable = await dependencies.resolveExecutable(candidate)
  if (!executable) {
    return { id: agent.id, label: agent.label, executable: candidate, state: "missing" }
  }

  const output = await dependencies.probe({
    command: executable,
    args: agent.id === "claude-code" ? ["auth", "status", "--json"] : ["login", "status"],
    env: dependencies.environment,
  })
  return agent.id === "claude-code"
    ? parseClaudeStatus(agent.label, executable, output)
    : parseCodexStatus(agent.label, executable, output)
}

function parseClaudeStatus(
  label: string,
  executable: string,
  output: SetupProbeOutput,
): HarnessSetupStatus {
  const base = { id: "claude-code" as const, label, executable }
  if (output.timedOut) return { ...base, state: "error", message: "Status check timed out" }

  let parsed: unknown
  try {
    parsed = JSON.parse(output.stdout)
  } catch {
    return output.code === 0
      ? { ...base, state: "error", message: "Claude Code returned an unknown status" }
      : { ...base, state: "unauthenticated" }
  }
  if (!isRecord(parsed) || typeof parsed.loggedIn !== "boolean") {
    return { ...base, state: "error", message: "Claude Code returned an unknown status" }
  }
  if (!parsed.loggedIn) {
    return {
      ...base,
      state: "unauthenticated",
      method: safeAuthMethod(parsed.authMethod),
    }
  }
  return {
    ...base,
    state: "authenticated",
    method: safeAuthMethod(parsed.authMethod) ?? safeAuthMethod(parsed.apiProvider),
    account: safeEmail(parsed.email) ?? safeEmail(parsed.account),
    plan: safePlan(parsed.subscriptionType) ?? safePlan(parsed.subscription),
  }
}

function parseCodexStatus(
  label: string,
  executable: string,
  output: SetupProbeOutput,
): HarnessSetupStatus {
  const base = { id: "codex" as const, label, executable }
  if (output.timedOut) return { ...base, state: "error", message: "Status check timed out" }
  const normalized = `${output.stdout}\n${output.stderr}`.trim().toLowerCase()
  if (normalized.includes("logged in")) {
    const method = normalized.includes("chatgpt")
      ? "ChatGPT"
      : normalized.includes("api key")
        ? "API key"
        : normalized.includes("access token")
          ? "Access token"
          : undefined
    return { ...base, state: "authenticated", ...(method ? { method } : {}) }
  }
  if (normalized.includes("not logged in") || output.code !== 0) {
    return { ...base, state: "unauthenticated" }
  }
  return { ...base, state: "error", message: "Codex returned an unknown status" }
}

/** Detect `gh` independently; it is optional and never blocks setup completion. */
export async function detectGitHub(
  dependencies: SetupStatusDependencies,
): Promise<GitHubSetupStatus> {
  const executable = await dependencies.resolveExecutable("gh")
  if (!executable) {
    return {
      executable: "gh",
      state: "missing",
      connectivity: "unchecked",
    }
  }
  const output = await dependencies.probe({
    command: executable,
    args: ["auth", "status", "--active", "--hostname", "github.com", "--json", "hosts"],
    env: dependencies.environment,
  })
  if (output.timedOut) {
    return {
      executable,
      state: "error",
      connectivity: "unavailable",
      message: "GitHub status check timed out",
    }
  }
  const account = parseGitHubAccount(output.stdout)
  if (output.code !== 0 || !account) {
    return {
      executable,
      state: "unauthenticated",
      connectivity: output.code === 0 ? "unavailable" : "unchecked",
    }
  }
  return {
    executable,
    state: "authenticated",
    account,
    connectivity: "available",
  }
}

function parseGitHubAccount(source: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !isRecord(parsed.hosts)) return undefined
  const github = parsed.hosts["github.com"]
  if (!Array.isArray(github)) return undefined
  const active = github.find((entry) => isRecord(entry) && entry.active === true)
  if (!isRecord(active) || active.state !== "success") return undefined
  return safeGitHubLogin(active.login)
}

const AUTH_METHODS: Readonly<Record<string, string>> = {
  "claude.ai": "Claude.ai",
  oauth: "OAuth",
  console: "Anthropic Console",
  apikey: "API key",
  "api key": "API key",
  firstparty: "First party",
  bedrock: "Amazon Bedrock",
  vertex: "Google Vertex AI",
  chatgpt: "ChatGPT",
  none: "None",
}

const PLAN_LABELS: Readonly<Record<string, string>> = {
  free: "Free",
  pro: "Pro",
  max: "Max",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  console: "Console/API billing",
  api: "API billing",
}

function safeAuthMethod(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  return AUTH_METHODS[printable(value).trim().toLowerCase()]
}

function safePlan(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  return PLAN_LABELS[printable(value).trim().toLowerCase()]
}

function safeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const clean = printable(value).trim().slice(0, 160)
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(clean) ? clean : undefined
}

function safeGitHubLogin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const clean = value.trim()
  return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/iu.test(clean) ? clean : undefined
}

function printable(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code >= 32 && code !== 127
    })
    .join("")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
