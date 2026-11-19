// Server data shared by several screens, read again for every new connection
// and every reopened socket: the Inbox (src/logic/inbox.ts) and the live agent
// states (`sessions.onStatus`).

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react"
import { useConnection } from "./connection"
import type { WaitingReason } from "./logic/agentStatus"
import { Inbox, type InboxItem, type InboxSource } from "./logic/inbox"

/** One live agent (`liveAgentStatusSchema` in the desktop's clientApi.ts). */
export interface LiveAgent {
  sessionId: string
  projectId: string
  projectName: string
  agentId: string
  workspaceId: string | null
  origin: string
  state: "working" | "waiting"
  /** Why a waiting agent waits; left out while it works. */
  waitingReason?: WaitingReason
}

interface DataValue {
  inbox: Inbox
  /** The Inbox rows; a new array after every change. */
  items: InboxItem[]
  /** Null until the first status event of this connection. */
  agents: LiveAgent[] | null
}

const DataContext = createContext<DataValue | null>(null)

export function DataProvider({ children }: { children: ReactNode }) {
  const { connection } = useConnection()
  const [items, setItems] = useState<InboxItem[]>([])
  const [agents, setAgents] = useState<LiveAgent[] | null>(null)
  const inbox = useMemo(() => new Inbox(() => setItems(inbox.items())), [])

  useEffect(() => {
    if (!connection) {
      inbox.stop()
      return
    }
    const { client, status } = connection
    const source: InboxSource = {
      subscribe: (handlers) => {
        const subscription = client.server.onNotification.subscribe(undefined, {
          onStarted: handlers.onStarted,
          onData: handlers.onMessage,
          onError: handlers.onError,
        })
        return () => subscription.unsubscribe()
      },
      history: () => client.server.notificationHistory.query(),
    }
    let statusSubscription: { unsubscribe: () => void } | null = null
    const read = () => {
      inbox.rebuild(source)
      statusSubscription?.unsubscribe()
      setAgents(null)
      statusSubscription = client.sessions.onStatus.subscribe(undefined, {
        onData: (sessions) => setAgents(sessions),
        onError: () => setAgents([]),
      })
    }
    read()
    // A socket that opens again may have missed clears: read everything again.
    const stopReopen = status.onReopened((name) => {
      if (name === "calls") read()
    })
    return () => {
      stopReopen()
      inbox.stop()
      statusSubscription?.unsubscribe()
    }
  }, [connection, inbox])

  return <DataContext.Provider value={{ inbox, items, agents }}>{children}</DataContext.Provider>
}

export function useData(): DataValue {
  const value = useContext(DataContext)
  if (!value) throw new Error("useData outside DataProvider")
  return value
}
