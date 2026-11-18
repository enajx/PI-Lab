import { basename, join } from "node:path"
import { TRPCError } from "@trpc/server"
import { app, BrowserWindow, clipboard, dialog, shell } from "electron"
import { z } from "zod"
import { electronMicrophone } from "../dictation/electronMicrophone"
import { nativeText } from "../i18n/nativeLanguage"
import type { MachineConnections } from "../machines/machineConnections"
import { behindPolicySchema, localServerModeSchema } from "../machines/machineStore"
import type { PortForwards } from "../machines/portForwards"
import { downloadEntry, uploadEntries } from "../machines/transfers"
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
  /** Remote machines this app connects to. */
  machines: () => MachineConnections
  /** Local forwards to notebook servers on remote machines. */
  forwards: () => PortForwards
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
      machines: router({
        /** Stored machines with their connection state (no tokens). */
        list: publicProcedure.query(() => deps.machines().list()),
        /** Enroll this app on `sshHost` over ssh, store the token, connect. */
        add: publicProcedure
          .input(z.object({ sshHost: z.string().trim().min(1), name: z.string().trim().min(1) }))
          .mutation(({ input }) => deps.machines().add(input)),
        /** Revoke this app's device on the machine when reachable, then forget it. */
        remove: publicProcedure
          .input(z.object({ machineId: z.string().min(1) }))
          .mutation(({ input }) => deps.machines().remove(input.machineId)),
        /** The machine's server WebSocket address (with token); asked on every connection attempt. */
        endpoint: publicProcedure
          .input(z.object({ machineId: z.string().min(1) }))
          .query(({ input }) => deps.machines().endpoint(input.machineId)),
        /** Install this app's server bundle on a machine that is behind ("Ask me"'s Update button). */
        update: publicProcedure
          .input(z.object({ machineId: z.string().min(1) }))
          .mutation(({ input }) => deps.machines().update(input.machineId)),
        /** "When a machine is behind this app". */
        behindPolicy: publicProcedure.query(() => deps.machines().behindPolicy()),
        setBehindPolicy: publicProcedure
          .input(z.object({ policy: behindPolicySchema }))
          .mutation(({ input }) => deps.machines().setBehindPolicy(input.policy)),
        /** "Local server" and the default machine of this device. */
        deviceSettings: publicProcedure.query(() => deps.machines().deviceSettings()),
        setLocalServer: publicProcedure
          .input(z.object({ mode: localServerModeSchema }))
          .mutation(({ input }) => deps.machines().setLocalServer(input.mode)),
        setDefaultMachine: publicProcedure
          .input(z.object({ machineId: z.string().min(1).nullable() }))
          .mutation(({ input }) => deps.machines().setDefaultMachine(input.machineId)),
        /**
         * The local port that reaches `port` on the machine's 127.0.0.1 (a
         * notebook or marimo server its PI Lab server started), for a frame here.
         */
        forwardPort: publicProcedure
          .input(
            z.object({ machineId: z.string().min(1), port: z.number().int().min(1).max(65_535) }),
          )
          .mutation(
            async ({ input }): Promise<{ localPort: number }> => ({
              localPort: await deps.forwards().localPort(input.machineId, input.port),
            }),
          ),
        /**
         * Download a file or folder of a project on the machine: a save dialog
         * picks where on this Mac. `savedTo` is null when the user cancels.
         */
        download: publicProcedure
          .input(z.object({ machineId: z.string().min(1) }).merge(workspaceEntry))
          .mutation(async ({ input }): Promise<{ savedTo: string | null }> => {
            const options = {
              defaultPath: join(app.getPath("downloads"), basename(input.relPath)),
              properties: ["createDirectory" as const],
            }
            const parent = dialogParent()
            const chosen = parent
              ? await dialog.showSaveDialog(parent, options)
              : await dialog.showSaveDialog(options)
            if (chosen.canceled || !chosen.filePath) return { savedTo: null }
            const endpoint = await deps.machines().httpEndpoint(input.machineId)
            await downloadEntry(endpoint, input, chosen.filePath)
            return { savedTo: chosen.filePath }
          }),
        /**
         * Upload files and folders from this Mac into a folder ("" is the root)
         * of a project on the machine: `paths` (dragged in), or null to pick them
         * in an open dialog. Each file that exists there asks Replace or Skip.
         */
        upload: publicProcedure
          .input(
            z.object({
              machineId: z.string().min(1),
              workspaceId: z.string().min(1),
              folderRelPath: z.string(),
              paths: z.array(z.string().min(1)).nullable(),
            }),
          )
          .mutation(async ({ input }): Promise<{ uploaded: string[]; skipped: string[] }> => {
            const parent = dialogParent()
            let paths = input.paths
            if (paths === null) {
              const options = {
                properties: [
                  "openFile" as const,
                  "openDirectory" as const,
                  "multiSelections" as const,
                ],
              }
              const chosen = parent
                ? await dialog.showOpenDialog(parent, options)
                : await dialog.showOpenDialog(options)
              if (chosen.canceled) return { uploaded: [], skipped: [] }
              paths = chosen.filePaths
            }
            const endpoint = await deps.machines().httpEndpoint(input.machineId)
            return uploadEntries(endpoint, input, paths, async (relPath) => {
              const options = {
                type: "question" as const,
                buttons: [nativeText("Replace"), nativeText("Skip")],
                defaultId: 1,
                cancelId: 1,
                message: nativeText("This file already exists on the other machine. Replace it?"),
                detail: relPath,
              }
              const answer = parent
                ? await dialog.showMessageBox(parent, options)
                : await dialog.showMessageBox(options)
              return answer.response === 0
            })
          }),
      }),
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

/** The window native dialogs attach to. */
function dialogParent(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined
}

export type DesktopRouter = ReturnType<typeof createDesktopRouter>
