import { homedir } from "node:os"
import {
  agentCredentials,
  agentSettings,
  getAgentSettingsOrDefaults,
  getSettingsOrDefaults,
  type NotificationSound,
  type PiLabDatabase,
  SETTINGS_ROW_ID,
  settings,
} from "@pi-lab/local-db"
import { z } from "zod"
import type { CredentialCipher } from "../../setup/credentials"
import {
  detectGitHub,
  detectHarnesses,
  type GitHubSetupStatus,
  type HarnessSetupStatus,
} from "../../setup/status"
import { detectLocalZotero, type LocalZoteroState, liveSetupPathExists } from "../../setup/zotero"
import { DEFAULT_SETUP_PROBE } from "../context"
import { writeAgentSettings } from "../settings/settings"
import { publicProcedure, router } from "../trpc"

export interface SetupEnvironmentStatus {
  harnesses: HarnessSetupStatus[]
  github: GitHubSetupStatus
  zotero: LocalZoteroState
  apiConfigured: Record<"claude-code" | "codex", boolean>
}

const completeInput = z.object({
  sound: z.enum(["chime", "pulse", "success", "alert", "silent"]),
})

const apiKeyInput = z.object({
  agentId: z.enum(["claude-code", "codex"]),
  apiKey: z.string().trim().min(1).max(16_384),
})

/** Encrypt and upsert a provider API key without returning it to the renderer. */
export function saveApiCredential(
  db: PiLabDatabase,
  cipher: CredentialCipher,
  agentId: "claude-code" | "codex",
  apiKey: string,
): void {
  db.insert(agentCredentials)
    .values({
      agentId,
      encryptedValue: cipher.encrypt(apiKey),
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: agentCredentials.agentId,
      set: { encryptedValue: cipher.encrypt(apiKey), updatedAt: Date.now() },
    })
    .run()
}

export function persistSetupCompletion(db: PiLabDatabase, sound: NotificationSound): void {
  const currentSettings = getSettingsOrDefaults(db)
  const currentAgents = getAgentSettingsOrDefaults(db)
  const notifications = {
    ...currentSettings.notifications,
    agentTurnCompletion: { ...currentSettings.notifications.agentTurnCompletion, sound },
    terminalCompletion: { ...currentSettings.notifications.terminalCompletion, sound },
    workflowCompletion: { ...currentSettings.notifications.workflowCompletion, sound },
  }
  const agents = { ...currentAgents, setupCompleted: true }
  const updatedAt = Date.now()
  db.transaction((transaction) => {
    transaction
      .insert(settings)
      .values({ id: SETTINGS_ROW_ID, notifications, updatedAt })
      .onConflictDoUpdate({
        target: settings.id,
        set: { notifications, updatedAt },
      })
      .run()
    transaction
      .insert(agentSettings)
      .values({ id: SETTINGS_ROW_ID, ...agents, updatedAt })
      .onConflictDoUpdate({
        target: agentSettings.id,
        set: { ...agents, updatedAt },
      })
      .run()
  })
}

export const setupRouter = router({
  /** Local-only, bounded status probes; raw command output never crosses this boundary. */
  environment: publicProcedure.query(async ({ ctx }): Promise<SetupEnvironmentStatus> => {
    const settings = getAgentSettingsOrDefaults(ctx.db)
    const environment = await ctx.getAgentLaunchEnvironment()
    const dependencies = {
      resolveExecutable: ctx.resolveAgentExecutable,
      probe: ctx.setupProbe ?? DEFAULT_SETUP_PROBE,
      environment,
    }
    const [harnesses, github, zotero, credentials] = await Promise.all([
      detectHarnesses(ctx.agentCatalog, settings.executableOverrides, dependencies),
      detectGitHub(dependencies),
      detectLocalZotero(ctx.httpFetch, process.platform, homedir(), liveSetupPathExists),
      Promise.resolve(
        ctx.db.select({ agentId: agentCredentials.agentId }).from(agentCredentials).all(),
      ),
    ])
    const configured = new Set(credentials.map((credential) => credential.agentId))
    return {
      harnesses,
      github,
      zotero,
      apiConfigured: {
        "claude-code": configured.has("claude-code"),
        codex: configured.has("codex"),
      },
    }
  }),

  /** Store a key encrypted by Electron safeStorage; never return key material over tRPC. */
  saveApiKey: publicProcedure.input(apiKeyInput).mutation(({ ctx, input }) => {
    saveApiCredential(ctx.db, ctx.credentialCipher, input.agentId, input.apiKey)
    return { configured: true }
  }),

  /** Finish applies the completion sound and marker atomically. */
  complete: publicProcedure.input(completeInput).mutation(({ ctx, input }): { completed: true } => {
    persistSetupCompletion(ctx.db, input.sound)
    return { completed: true }
  }),

  /** Skip records only that the first-launch surface has been seen. */
  skip: publicProcedure.mutation(({ ctx }): { completed: true } => {
    writeAgentSettings(ctx.db, { setupCompleted: true })
    return { completed: true }
  }),
})
