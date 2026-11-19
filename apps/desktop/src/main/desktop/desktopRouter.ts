import { TRPCError } from "@trpc/server"
import { clipboard, shell } from "electron"
import { z } from "zod"
import { electronMicrophone } from "../dictation/electronMicrophone"
import type { NotificationBrokers } from "../notifications"
import type { ServerClient } from "../server/client"
import type { AppContext } from "../trpc/context"
import { notificationsRouter } from "../trpc/notifications"
import { systemRouter } from "../trpc/system"
import { publicProcedure, router } from "../trpc/trpc"

/** What the desktop router needs from Electron main. */
export interface DesktopRouterDependencies {
  /** The connected server client; waits while the server starts. */
  server: () => Promise<ServerClient>
  /** The renderer's server WebSocket address (with token), once the server runs. */
  rendererEndpoint: () => Promise<{ url: string }>
}

/**
 * The desktop context: only the notification brokers of this device. The
 * desktop procedures get everything else from {@link DesktopRouterDependencies}.
 * Cast once here because these routers are typed over the shared AppContext
 * but read no other field.
 */
export function desktopContext(notifications: NotificationBrokers): AppContext {
  return { notifications } as AppContext
}

const workspaceEntry = z.object({ workspaceId: z.string().min(1), relPath: z.string().min(1) })

/**
 * Calls served by Electron over IPC (see shared/desktopPaths.ts): native
 * dialogs and windows, this device's notifications and microphone, and the
 * device side of Finder, clipboard and open actions. Paths and inputs match
 * the server's procedures of the same name, so the renderer's single client
 * type covers both.
 */
export function createDesktopRouter(deps: DesktopRouterDependencies) {
  return router({
    desktop: router({
      /** Where the renderer's server WebSocket connects; waits while the server starts. */
      serverEndpoint: publicProcedure.query(() => deps.rendererEndpoint()),
    }),
    system: systemRouter,
    notifications: notificationsRouter,
    dictation: router({
      status: publicProcedure.query(async () => ({
        ...(await (await deps.server()).dictation.status.query()),
        microphone: electronMicrophone.status(),
      })),
      requestMicrophone: publicProcedure.mutation(async () => ({
        granted: await electronMicrophone.request(),
      })),
      openMicrophoneSettings: publicProcedure.mutation(() => electronMicrophone.openSettings()),
    }),
    files: router({
      reveal: publicProcedure.input(workspaceEntry).mutation(async ({ input }): Promise<void> => {
        shell.showItemInFolder(await (await deps.server()).files.revealTarget.query(input))
      }),
      copyPath: publicProcedure
        .input(workspaceEntry.extend({ form: z.enum(["absolute", "relative"]) }))
        .mutation(async ({ input }): Promise<void> => {
          clipboard.writeText(await (await deps.server()).files.copyPathText.query(input))
        }),
    }),
    documents: router({
      openInBrowser: publicProcedure
        .input(z.object({ projectId: z.string().min(1), relPath: z.string().min(1) }))
        .mutation(async ({ input }): Promise<void> => {
          const path = await (await deps.server()).documents.openInBrowserTarget.query(input)
          const error = await shell.openPath(path)
          if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error })
        }),
    }),
    notebooks: router({
      openInBrowser: publicProcedure
        .input(z.object({ serverId: z.string().min(1) }))
        .mutation(async ({ input }): Promise<void> => {
          await shell.openExternal(await (await deps.server()).notebooks.browserUrl.query(input))
        }),
    }),
    science: router({
      library: router({
        openItem: publicProcedure
          .input(z.object({ path: z.string().min(1) }))
          .mutation(async ({ input }) =>
            openTarget(await (await deps.server()).science.library.openItemTarget.query(input)),
          ),
        openZoteroItem: publicProcedure
          .input(z.object({ itemKey: z.string().min(1) }))
          .mutation(async ({ input }) =>
            openTarget(
              await (await deps.server()).science.library.openZoteroItemTarget.query(input),
            ),
          ),
      }),
    }),
  })
}

type OpenTargetResult = Awaited<
  ReturnType<ServerClient["science"]["library"]["openItemTarget"]["query"]>
>

/** Open a resolved library file with this device's default app. */
async function openTarget(target: OpenTargetResult) {
  if (!target.ok) return target
  const error = await shell.openPath(target.path)
  if (error) return { ok: false as const, reason: "error" as const, message: error }
  return { ok: true as const }
}

export type DesktopRouter = ReturnType<typeof createDesktopRouter>
