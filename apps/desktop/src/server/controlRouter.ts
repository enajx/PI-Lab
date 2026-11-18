import { hostname } from "node:os"
import { agentCredentials, getSettingsOrDefaults, serviceCredentials } from "@pi-lab/local-db"
import { TRPCError } from "@trpc/server"
import { observable } from "@trpc/server/observable"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { getDbStatus } from "../main/db/db"
import { loadNativeLanguage } from "../main/i18n/nativeLanguage"
import type { AppContext } from "../main/trpc/context"
import { writeGeneralSettings } from "../main/trpc/settings/settings"
import { publicProcedure, router } from "../main/trpc/trpc"
import type { DataCompatibility } from "../main/updates/compatibility"
import type { PublicUpdateChannel } from "../main/updates/release"
import {
  initializePublicUpdateChannel,
  onPublicUpdateChannelChanged,
} from "../main/updates/selection"
import type { QuitWork } from "../main/window/userQuit"
import type { BackgroundTraySnapshot } from "../shared/backgroundTray"
import {
  answerRequestResultSchema,
  appSettingsSchema,
  backgroundTraySnapshotSchema,
  createdDeviceSchema,
  dataCompatibilitySchema,
  deviceSchema,
  legacyCredentialMoveSchema,
  legacyCredentialSchema,
  notebookCountSchema,
  notificationEventSchema,
  notificationStreamMessageSchema,
  okSchema,
  projectFileRouteSchema,
  publicUpdateChannelSchema,
  pythonRuntimeSchema,
  quickPythonOptionsSchema,
  quickPythonRunSchema,
  quitWorkSchema,
  SERVER_CAPABILITIES,
  SERVER_UPDATE_CAPABILITY,
  secretProtectionSchema,
  serverHelloSchema,
  serverUpdateSettingsSchema,
} from "../shared/clientApi"
import { LOCAL_DEVICE_ID } from "./devices"
import type { NotificationEvent, NotificationStreamMessage } from "./notificationFeed"
import type { ServerRuntime } from "./runtime"
import { readUpdateSettings, writeUpdateSettings } from "./selfUpdate"

/** Protocol version of the client API; bumped on breaking changes. */
export const PROTOCOL_VERSION = 1

/** What the server tells a client when it connects. */
export interface ServerHello {
  protocol: number
  build: string
  version: string
  pid: number
  capabilities: string[]
  machineId: string
  hostname: string
  platform: string
  arch: string
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

/** Device management and stopping the server are for the local device ("This Mac") only. */
function localDeviceOnly(ctx: AppContext): void {
  if (ctx.connection?.deviceId !== LOCAL_DEVICE_ID) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the local device can manage devices and stop the server",
    })
  }
}

/** Requests whose answer is being written now; a second answer meanwhile gets `already-answered`. */
const answering = new Set<string>()

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
  hello: publicProcedure.output(serverHelloSchema).query(({ ctx }): ServerHello => {
    const { runtime } = control(ctx)
    return {
      protocol: PROTOCOL_VERSION,
      build: runtime.config.build,
      version: runtime.config.version,
      pid: process.pid,
      capabilities: [
        ...SERVER_CAPABILITIES,
        ...(runtime.config.install ? [SERVER_UPDATE_CAPABILITY] : []),
      ],
      machineId: runtime.machineId,
      hostname: hostname(),
      platform: process.platform,
      arch: process.arch,
    }
  }),

  /** Devices allowed to connect (see {@link DeviceRegistry}). */
  devices: router({
    list: publicProcedure
      .output(z.array(deviceSchema))
      .query(({ ctx }) => control(ctx).runtime.devices.list()),
    /** Add a device; the reply is the only place its token is ever shown. */
    create: publicProcedure
      .input(z.object({ name: z.string().trim().min(1) }))
      .output(createdDeviceSchema)
      .mutation(({ ctx, input }) => {
        localDeviceOnly(ctx)
        return control(ctx).runtime.devices.create(input.name)
      }),
    /** Revoke a device: its open connections close and its token is refused from now on. */
    revoke: publicProcedure
      .input(z.object({ id: z.string().min(1) }))
      .output(okSchema)
      .mutation(({ ctx, input }): { ok: true } => {
        localDeviceOnly(ctx)
        const { devices } = control(ctx).runtime
        if (input.id === LOCAL_DEVICE_ID) {
          throw new TRPCError({ code: "FORBIDDEN", message: "The local device cannot be revoked" })
        }
        if (!devices.list().some((device) => device.id === input.id)) {
          throw new TRPCError({ code: "NOT_FOUND", message: `No device ${input.id}` })
        }
        devices.revoke(input.id)
        return { ok: true }
      }),
  }),

  /** Stop the server; with `stopAgents` every agent, shell and the PTY daemon stop first. */
  stop: publicProcedure
    .input(z.object({ stopAgents: z.boolean() }))
    .output(okSchema)
    .mutation(async ({ ctx, input }): Promise<{ ok: true }> => {
      localDeviceOnly(ctx)
      const port = control(ctx)
      if (input.stopAgents) await port.runtime.stopAllWork()
      port.exit()
      return { ok: true }
    }),

  quitWork: publicProcedure
    .output(quitWorkSchema)
    .query(({ ctx }): Promise<QuitWork> => control(ctx).runtime.quitWork()),
  /** Open notebook tabs whose servers run; cheap, for the Quit dialog. */
  notebookCount: publicProcedure
    .output(notebookCountSchema)
    .query(({ ctx }): number => control(ctx).runtime.notebookServers.runningCount()),

  traySnapshot: publicProcedure
    .output(backgroundTraySnapshotSchema)
    .query(({ ctx }): BackgroundTraySnapshot => control(ctx).runtime.traySnapshot()),
  onTray: publicProcedure.subscription(({ ctx }) => {
    const { runtime } = control(ctx)
    return observable<BackgroundTraySnapshot>((emit) =>
      runtime.activityRegistry.subscribe(() =>
        emit.next(backgroundTraySnapshotSchema.parse(runtime.traySnapshot())),
      ),
    )
  }),
  hasProject: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .output(z.boolean())
    .query(({ ctx, input }): boolean => control(ctx).runtime.hasProject(input.id)),
  /** The project holding a file, for opening it in the project editor. */
  projectForFile: publicProcedure
    .input(z.object({ path: z.string().min(1) }))
    .output(projectFileRouteSchema)
    .query(({ ctx, input }) => control(ctx).runtime.projectRouteForFile(input.path)),

  /** Settings the desktop app reads outside the renderer. */
  appSettings: publicProcedure
    .output(appSettingsSchema)
    .query(({ ctx }): AppSettings => appSettings(ctx)),
  /** The same settings, again after every settings change. */
  onAppSettings: publicProcedure.subscription(({ ctx }) => {
    const { runtime } = control(ctx)
    return observable<AppSettings>((emit) => {
      const send = () => emit.next(appSettingsSchema.parse(appSettings(ctx)))
      send()
      return runtime.onAppSettingsChanged(send)
    })
  }),
  /** Re-read the interface language the desktop app saved, for notification text. */
  reloadLanguage: publicProcedure.output(z.void()).mutation(({ ctx }) => {
    loadNativeLanguage(control(ctx).runtime.config.profileDir)
  }),
  rememberQuitChoice: publicProcedure
    .input(z.object({ choice: z.literal("background") }))
    .output(z.void())
    .mutation(({ ctx, input }) => {
      writeGeneralSettings(ctx.db, { quitChoice: input.choice })
    }),
  /** Seed a new public install's update channel before setup writes settings. */
  initPublicUpdateChannel: publicProcedure
    .input(z.object({ channel: z.enum(["stable", "beta"]) }).nullable())
    .output(z.void())
    .mutation(({ ctx, input }) => {
      initializePublicUpdateChannel(ctx.db, input)
    }),

  /** "Update machines automatically" for this server (see selfUpdate.ts). */
  updates: router({
    settings: publicProcedure.output(serverUpdateSettingsSchema).query(({ ctx }) => {
      const { runtime } = control(ctx)
      return {
        autoUpdate: readUpdateSettings(runtime.config.dataDir).autoUpdate,
        selfUpdate: runtime.config.install !== null,
      }
    }),
    setAutoUpdate: publicProcedure
      .input(z.object({ autoUpdate: z.boolean() }))
      .output(okSchema)
      .mutation(({ ctx, input }) => {
        writeUpdateSettings(control(ctx).runtime.config.dataDir, { autoUpdate: input.autoUpdate })
        return { ok: true as const }
      }),
  }),

  /** The data format of this server's database, for the desktop updater. */
  updateCompatibility: publicProcedure
    .output(dataCompatibilitySchema)
    .query((): DataCompatibility => getDbStatus().compatibility),
  /** The selected public update channel now, then again after each change. */
  onPublicUpdateChannel: publicProcedure.subscription(({ ctx }) =>
    observable<PublicUpdateChannel>((emit) => {
      const send = (channel: PublicUpdateChannel) =>
        emit.next(publicUpdateChannelSchema.parse(channel))
      send(getSettingsOrDefaults(ctx.db).publicUpdateChannel)
      return onPublicUpdateChannelChanged(send)
    }),
  ),

  /** Alerts for this client: pending requests first, then live events and clears. */
  onNotification: publicProcedure.subscription(({ ctx }) => {
    const { runtime } = control(ctx)
    return observable<NotificationStreamMessage>((emit) =>
      runtime.notifications.subscribe((message) =>
        emit.next(notificationStreamMessageSchema.parse(message)),
      ),
    )
  }),
  /**
   * Answer a pending request from any device. The first answer is typed into
   * the agent's terminal (text and Enter, in bracketed paste when the program
   * turned it on) and the request clears everywhere once the write succeeded;
   * any other answer gets `already-answered` and writes nothing. A failed
   * write leaves the request pending and returns the error.
   */
  answerRequest: publicProcedure
    .input(z.object({ requestId: z.string().min(1), text: z.string() }))
    .output(answerRequestResultSchema)
    .mutation(async ({ ctx, input }): Promise<{ status: "accepted" | "already-answered" }> => {
      const { notifications } = control(ctx).runtime
      // Checked and claimed synchronously, before any await, so two answers can never both write.
      const event = notifications.pending(input.requestId)
      if (!event || answering.has(input.requestId)) return { status: "already-answered" }
      const target = event.request.target
      if (target.type !== "agent") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Request ${input.requestId} is not an agent request`,
        })
      }
      answering.add(input.requestId)
      const written = (async () => {
        const daemon = await ctx.getDaemonClient()
        ctx.activityMonitor.userInput(target.sessionId, `${input.text}\r`)
        await daemon.writeMessage(target.sessionId, input.text)
      })()
      await written.finally(() => answering.delete(input.requestId))
      notifications.take(input.requestId)
      return { status: "accepted" }
    }),
  notificationHistory: publicProcedure
    .output(z.array(notificationEventSchema))
    .query(({ ctx }): NotificationEvent[] => control(ctx).runtime.notifications.history()),

  secretProtection: publicProcedure
    .output(secretProtectionSchema)
    .query(({ ctx }) => control(ctx).runtime.secrets.protection()),
  setSecretProtection: publicProcedure
    .input(z.object({ mode: z.enum(["file", "keychain"]) }))
    .output(secretProtectionSchema)
    .mutation(({ ctx, input }) => {
      const { secrets } = control(ctx).runtime
      secrets.setProtection(input.mode)
      return secrets.protection()
    }),

  /** Credentials still in the old safeStorage format, for the desktop app to move. */
  legacyCredentials: publicProcedure
    .output(z.array(legacyCredentialSchema))
    .query(({ ctx }): LegacyCredential[] => {
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
    .output(legacyCredentialMoveSchema)
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
  stopNotebooks: publicProcedure
    .output(z.void())
    .mutation(({ ctx }) => control(ctx).runtime.notebookServers.stopAll()),

  /** Stop every Analysis preview (marimo, report grants): the desktop page that showed them went away. */
  stopAnalysisPreviews: publicProcedure
    .output(z.void())
    .mutation(({ ctx }) => control(ctx).runtime.analysisInteractive.closeAll()),

  /** Quick Editor's Python run, through the server's PTY daemon. */
  quickPythonOptions: publicProcedure
    .input(z.object({ path: z.string().min(1) }))
    .output(quickPythonOptionsSchema)
    .query(({ ctx, input }) => control(ctx).runtime.quickPython.options(input.path)),
  quickPythonSelect: publicProcedure
    .input(z.object({ path: z.string().min(1), interpreter: z.string().min(1).nullable() }))
    .output(pythonRuntimeSchema)
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
    .output(quickPythonRunSchema)
    .mutation(({ ctx, input }) =>
      control(ctx).runtime.quickPython.run(input.path, input.cols, input.rows),
    ),
  quickPythonKill: publicProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .output(z.void())
    .mutation(({ ctx, input }) => control(ctx).runtime.quickPython.kill(input.sessionId)),
})
