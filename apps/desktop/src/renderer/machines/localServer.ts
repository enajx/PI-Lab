import { TRPCClientError, type TRPCLink } from "@trpc/client"
import type { AnyRouter } from "@trpc/server"
import { observable } from "@trpc/server/observable"

/** Why a local call fails when this app started with "Local server: Off". */
export const LOCAL_SERVER_OFF_MESSAGE =
  "This Mac's PI Lab server is off (Settings > Machines > Local server)."

/**
 * True when this app started with "Local server: Off": there is no local
 * server this session, so the local project list and local-only parts are not
 * offered. Read once by the preload; a change in Settings applies at the next
 * start.
 */
export function localServerOff(): boolean {
  // Typed here too: main's tsconfig reaches this file without the renderer's Window declaration.
  const bridge = (globalThis as { piLab?: { localServerOff?: boolean } }).piLab
  return bridge?.localServerOff === true
}

/** The link that stands in for the local server's sockets when it is off: every call fails at once. */
export function localServerOffLink<TRouter extends AnyRouter>(): TRPCLink<TRouter> {
  return () => () =>
    observable((observer) => {
      observer.error(TRPCClientError.from(new Error(LOCAL_SERVER_OFF_MESSAGE)))
    })
}
