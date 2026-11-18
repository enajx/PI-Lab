import { agentCredentials, getSettingsOrDefaults, serviceCredentials } from "@pi-lab/local-db"
import { TRPCError } from "@trpc/server"
import { observable } from "@trpc/server/observable"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { loadNativeLanguage } from "../main/i18n/nativeLanguage"
import type { AppContext } from "../main/trpc/context"
import { writeGeneralSettings } from "../main/trpc/settings/settings"
import { publicProcedure, router } from "../main/trpc/trpc"
import { initializePublicUpdateChannel } from "../main/updates/selection"
import type { QuitWork } from "../main/window/userQuit"
import type { BackgroundTraySnapshot } from "../shared/backgroundTray"
import type { NotificationEvent, NotificationStreamMessage } from "./notificationFeed"
import type { ServerRuntime } from "./runtime"

/** Protocol version of the client API; bumped on breaking changes. */
export const PROTOCOL_VERSION = 1

/** What the server tells a client when it connects. */
export interface ServerHello {
  protocol: number
  build: string
  version: string
  pid: number
  capabilities: string[]
}

/** The server-only services the control router reaches through the context. */
export interface ServerControlPort {
  runtime: ServerRuntime
  /** Exit the server process after the current reply is sent. */
  exit: () => void
}

function control(ctx: AppContext): ServerControlPort {
  if (!ctx.server) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Not running in the PI Lab server",
    })
  }
  return ctx.server
}

/** Settings Electron main keeps a copy of. */
export interface AppSettings {
  keepRunningAfterClose: boolean
  quitChoice: "ask" | "background"
  editorVim: boolean
}

function appSettings(ctx: AppContext): AppSettings {
  const settings = getSettingsOrDefaults(ctx.db)
  return {
    keepRunningAfterClose: settings.keepRunningAfterClose,
    quitChoice: settings.quitChoice,
    editorVim: settings.editor.vim,
  }
}

/** A credential row still encrypted by the old app's Electron safeStorage. */
export interface LegacyCredential {
  table: "agent" | "service"
  key: string
  encryptedValue: string
}

const legacyInput = z.object({
  table: z.enum(["agent", "service"]),
  key: z.string().min(1),
  /** The legacy value the client decrypted; the row is changed only if it still holds it. */
  encryptedValue: z.string().min(1),
  plaintext: z.string(),
})

/**
 * Server-level calls: hello, stop, the tray monitor data, the Quit dialog's
 * work count, notifications, secrets and the one-time credential move.
 */
export const serverControlRouter = router({
  hello: publicProcedure.query(({ ctx }): ServerHello => {
    const { runtime } = control(ctx)
    return {
      protocol: PROTOCOL_VERSION,
      build: runtime.config.build,
      version: runtime.config.version,
      pid: process.pid,
      capabilities: [],
    }
  }),

  /** Stop the server; with `stopAgents` every agent, shell and the PTY daemon stop first. */
  stop: publicProcedure
    .input(z.object({ stopAgents: z.boolean() }))
    .mutation(async ({ ctx, input }): Promise<{ ok: true }> => {
      const port = control(ctx)
      if (input.stopAgents) await port.runtime.stopAllWork()
      port.exit()
      return { ok: true }
    }),

  quitWork: publicProcedure.query(({ ctx }): Promise<QuitWork> => control(ctx).runtime.quitWork()),

  traySnapshot: publicProcedure.query(
    ({ ctx }): BackgroundTraySnapshot => control(ctx).runtime.traySnapshot(),
  ),
  onTray: publicProcedure.subscription(({ ctx }) => {
    const { runtime } = control(ctx)
    return observable<BackgroundTraySnapshot>((emit) =>
      runtime.activityRegistry.subscribe(() => emit.next(runtime.traySnapshot())),
    )
  }),
  hasProject: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ ctx, input }): boolean => control(ctx).runtime.hasProject(input.id)),
  /** The project holding a file, for opening it in the project editor. */
  projectForFile: publicProcedure
    .input(z.object({ path: z.string().min(1) }))
    .query(({ ctx, input }) => control(ctx).runtime.projectRouteForFile(input.path)),

  /** Settings the desktop app reads outside the renderer. */
  appSettings: publicProcedure.query(({ ctx }): AppSettings => appSettings(ctx)),
  /** The same settings, again after every settings change. */
  onAppSettings: publicProcedure.subscription(({ ctx }) => {
    const { runtime } = control(ctx)
    return observable<AppSettings>((emit) => {
      emit.next(appSettings(ctx))
      return runtime.onAppSettingsChanged(() => emit.next(appSettings(ctx)))
    })
  }),
  /** Re-read the interface language the desktop app saved, for notification text. */
  reloadLanguage: publicProcedure.mutation(({ ctx }) => {
    loadNativeLanguage(control(ctx).runtime.config.dataDir)
  }),
  rememberQuitChoice: publicProcedure
    .input(z.object({ choice: z.literal("background") }))
    .mutation(({ ctx, input }) => {
      writeGeneralSettings(ctx.db, { quitChoice: input.choice })
    }),
  /** Seed a new public install's update channel before setup writes settings. */
  initPublicUpdateChannel: publicProcedure
    .input(z.object({ channel: z.enum(["stable", "beta"]) }).nullable())
    .mutation(({ ctx, input }) => {
      initializePublicUpdateChannel(ctx.db, input)
    }),

  /** Alerts for this client: pending requests first, then live events and clears. */
  onNotification: publicProcedure.subscription(({ ctx }) => {
    const { runtime } = control(ctx)
    return observable<NotificationStreamMessage>((emit) =>
      runtime.notifications.subscribe((message) => emit.next(message)),
    )
  }),
  notificationHistory: publicProcedure.query(({ ctx }): NotificationEvent[] =>
    control(ctx).runtime.notifications.history(),
  ),

  secretProtection: publicProcedure.query(({ ctx }) => control(ctx).runtime.secrets.protection()),
  setSecretProtection: publicProcedure
    .input(z.object({ mode: z.enum(["file", "keychain"]) }))
    .mutation(({ ctx, input }) => {
      const { secrets } = control(ctx).runtime
      secrets.setProtection(input.mode)
      return secrets.protection()
    }),

  /** Credentials still in the old safeStorage format, for the desktop app to move. */
  legacyCredentials: publicProcedure.query(({ ctx }): LegacyCredential[] => {
    const { secrets } = control(ctx).runtime
    return [
      ...ctx.db
        .select()
        .from(agentCredentials)
        .all()
        .map((row) => ({
          table: "agent" as const,
          key: row.agentId,
          encryptedValue: row.encryptedValue,
        })),
      ...ctx.db
        .select()
        .from(serviceCredentials)
        .all()
        .map((row) => ({
          table: "service" as const,
          key: row.service,
          encryptedValue: row.encryptedValue,
        })),
    ].filter((row) => !secrets.isCurrentFormat(row.encryptedValue))
  }),
  /** Re-encrypt one moved credential; a row changed meanwhile is left alone. */
  moveLegacyCredential: publicProcedure
    .input(legacyInput)
    .mutation(({ ctx, input }): { moved: boolean } => {
      const encryptedValue = control(ctx).runtime.secrets.encrypt(input.plaintext)
      const updatedAt = Date.now()
      const changed =
        input.table === "agent"
          ? ctx.db
              .update(agentCredentials)
              .set({ encryptedValue, updatedAt })
              .where(
                and(
                  eq(agentCredentials.agentId, input.key),
                  eq(agentCredentials.encryptedValue, input.encryptedValue),
                ),
              )
              .run().changes
          : ctx.db
              .update(serviceCredentials)
              .set({ encryptedValue, updatedAt })
              .where(
                and(
                  eq(serviceCredentials.service, input.key),
                  eq(serviceCredentials.encryptedValue, input.encryptedValue),
                ),
              )
              .run().changes
      return { moved: changed === 1 }
    }),

  /** Stop every notebook server: the desktop page that showed them reloaded or closed. */
  stopNotebooks: publicProcedure.mutation(({ ctx }) =>
    control(ctx).runtime.notebookServers.stopAll(),
  ),

  /** Quick Editor's Python run, through the server's PTY daemon. */
  quickPythonOptions: publicProcedure
    .input(z.object({ path: z.string().min(1) }))
    .query(({ ctx, input }) => control(ctx).runtime.quickPython.options(input.path)),
  quickPythonSelect: publicProcedure
    .input(z.object({ path: z.string().min(1), interpreter: z.string().min(1).nullable() }))
    .mutation(({ ctx, input }) =>
      control(ctx).runtime.quickPython.select(input.path, input.interpreter),
    ),
  quickPythonRun: publicProcedure
    .input(
      z.object({
        path: z.string().min(1),
        cols: z.number().int().positive(),
        rows: z.number().int().positive(),
      }),
    )
    .mutation(({ ctx, input }) =>
      control(ctx).runtime.quickPython.run(input.path, input.cols, input.rows),
    ),
  quickPythonKill: publicProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .mutation(({ ctx, input }) => control(ctx).runtime.quickPython.kill(input.sessionId)),
})
