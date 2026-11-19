// One owner of the server connection. It builds the two tRPC sockets with the
// desktop's own constructor (serverLinks.ts) and connection state
// (connectionStatus.ts); tRPC reconnects a dropped socket, and nothing else
// dials. When the app goes to the background both sockets are closed; when it
// returns, the token is checked and new sockets are made.

import { createTRPCClient, type TRPCClient } from "@trpc/client"
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react"
import { AppState } from "react-native"
import type { ServerRouter } from "../../desktop/src/main/trpc/serverRouter"
import { ConnectionStatus, useStatusState } from "../../desktop/src/renderer/trpc/connectionStatus"
import { createServerSockets } from "../../desktop/src/renderer/trpc/serverLinks"
import { endpointFor, type ServerLogin } from "./logic/address"
import { readLogin, writeLogin } from "./storage"

export type Client = TRPCClient<ServerRouter>

/** One set of open sockets; a new one is made for every connection. */
export interface ServerConnection {
  client: Client
  status: ConnectionStatus
  /** Counts connections, so screens can tell a new one from the last. */
  key: number
  close: () => Promise<void>
}

/** What the app knows about the connection. */
export type ConnectionPhase =
  | { kind: "starting" }
  | { kind: "login"; login: ServerLogin | null; error: string | null }
  | { kind: "online"; login: ServerLogin }

interface ConnectionContextValue {
  phase: ConnectionPhase
  /** Null while in the background, checking the token, or on the connect screen. */
  connection: ServerConnection | null
  /** The server's capabilities (`server.hello`), or null before the first answer. */
  capabilities: string[] | null
  /** Save a login and connect with it. */
  submitLogin: (login: ServerLogin) => Promise<void>
  /** Close the connection and show the connect screen. */
  openLogin: () => void
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null)

/** The token check: "ok", "refused" (401), or "unreachable" with the reason. */
async function checkToken(
  login: ServerLogin,
): Promise<{ kind: "ok" } | { kind: "refused" } | { kind: "unreachable"; reason: string }> {
  const { healthUrl } = endpointFor(login.address, login.token)
  const response = await fetch(healthUrl, { headers: { "x-pi-lab-token": login.token } }).catch(
    (error: unknown) => String(error),
  )
  if (typeof response === "string") return { kind: "unreachable", reason: response }
  if (response.status === 401) return { kind: "refused" }
  if (!response.ok) return { kind: "unreachable", reason: `HTTP ${response.status}` }
  return { kind: "ok" }
}

let connectionCount = 0

function openConnection(login: ServerLogin): ServerConnection {
  const { trpcUrl } = endpointFor(login.address, login.token)
  const status = new ConnectionStatus()
  const sockets = createServerSockets<ServerRouter>({
    url: async () => trpcUrl,
    WebSocket: globalThis.WebSocket,
    status,
  })
  connectionCount += 1
  return {
    client: createTRPCClient<ServerRouter>({ links: [sockets.link] }),
    status,
    key: connectionCount,
    close: sockets.close,
  }
}

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<ConnectionPhase>({ kind: "starting" })
  const [connection, setConnection] = useState<ServerConnection | null>(null)
  const [capabilities, setCapabilities] = useState<string[] | null>(null)
  const [foreground, setForeground] = useState(AppState.currentState !== "background")

  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") setForeground(true)
      if (state === "background") setForeground(false)
    })
    return () => listener.remove()
  }, [])

  // Read the stored login once.
  useEffect(() => {
    void readLogin().then((login) =>
      setPhase(login ? { kind: "online", login } : { kind: "login", login: null, error: null }),
    )
  }, [])

  // Connect while online and in the foreground; close on background or logout.
  const login = phase.kind === "online" ? phase.login : null
  useEffect(() => {
    if (!login || !foreground) return
    let opened: ServerConnection | null = null
    let cancelled = false
    void checkToken(login).then((check) => {
      if (cancelled) return
      if (check.kind === "refused") {
        setPhase({ kind: "login", login, error: "The server refused this device token." })
        return
      }
      // An unreachable server is still dialled: tRPC retries, the indicator shows the state.
      opened = openConnection(login)
      setCapabilities(null)
      setConnection(opened)
      const current = opened
      // Read again after a failure: the session screen waits for the capabilities.
      const readHello = (): Promise<void> =>
        current.client.server.hello.query().then(
          (hello) => {
            if (!cancelled) setCapabilities(hello.capabilities)
          },
          () => {
            if (!cancelled) setTimeout(() => void readHello(), 2000)
          },
        )
      void readHello()
      current.status.onReopened((name) => {
        if (name === "calls") void readHello()
      })
    })
    return () => {
      cancelled = true
      setConnection(null)
      if (opened) void opened.close()
    }
  }, [login, foreground])

  const submitLogin = useCallback(async (next: ServerLogin) => {
    endpointFor(next.address, next.token)
    await writeLogin(next)
    setPhase({ kind: "online", login: next })
  }, [])

  const openLogin = useCallback(() => {
    setPhase((current) => ({
      kind: "login",
      login: current.kind === "online" ? current.login : null,
      error: null,
    }))
  }, [])

  return (
    <ConnectionContext.Provider value={{ phase, connection, capabilities, submitLogin, openLogin }}>
      {children}
    </ConnectionContext.Provider>
  )
}

export function useConnection(): ConnectionContextValue {
  const value = useContext(ConnectionContext)
  if (!value) throw new Error("useConnection outside ConnectionProvider")
  return value
}

/** "connected", "reconnecting", "disconnected", or "offline" while there are no sockets. */
export function useConnectionState(): string {
  const { connection } = useConnection()
  return useStatusStateOrOffline(connection?.status ?? null)
}

const offlineStatus = new ConnectionStatus()
offlineStatus.socketCreated("none")
offlineStatus.socketClosed("none")

function useStatusStateOrOffline(status: ConnectionStatus | null): string {
  const state = useStatusState(status ?? offlineStatus)
  return status === null ? "offline" : state
}
