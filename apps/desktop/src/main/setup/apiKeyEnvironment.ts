import { agentCredentials, type PiLabDatabase } from "@pi-lab/local-db"
import { TRPCError } from "@trpc/server"
import { eq } from "drizzle-orm"
import type { CredentialCipher } from "./credentials"

/** Environment variables each provider CLI reads its API key from. */
const API_KEY_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  "claude-code": ["ANTHROPIC_API_KEY"],
  // `codex exec` reads CODEX_API_KEY; the interactive CLI reads OPENAI_API_KEY.
  codex: ["CODEX_API_KEY", "OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY"],
}

/**
 * Extra environment for one agent launch. With "api-key" picked, the saved key
 * is decrypted and set in the provider's variables; otherwise nothing is added
 * and the CLI uses its own login. Picking "api-key" without a saved key fails
 * the launch instead of silently using the subscription.
 */
export function apiKeyLaunchEnvironment(
  db: PiLabDatabase,
  cipher: CredentialCipher,
  agent: { id: string; label: string },
  authMethod: "subscription" | "api-key" | undefined,
): Record<string, string> {
  if (authMethod !== "api-key") return {}
  const variables = API_KEY_VARIABLES[agent.id]
  if (!variables) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${agent.label} cannot use an API key from PI Lab.`,
    })
  }
  const row = db
    .select({ encryptedValue: agentCredentials.encryptedValue })
    .from(agentCredentials)
    .where(eq(agentCredentials.agentId, agent.id))
    .get()
  if (!row) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${agent.label} is set to use an API key, but no API key is saved. Add one in Settings → Agents & worktrees, or switch it to Subscription.`,
    })
  }
  const key = cipher.decrypt(row.encryptedValue)
  return Object.fromEntries(variables.map((name) => [name, key]))
}
