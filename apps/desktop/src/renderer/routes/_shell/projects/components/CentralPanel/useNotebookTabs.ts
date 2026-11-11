import { useCallback, useEffect, useRef, useState } from "react"
import type { PiLabTrpcClient } from "../../../../../trpc/client"

/** One notebook tab: a marimo or Jupyter notebook on its own local server. */
export interface NotebookPane {
  /** Also the server id in Electron main, so closing the tab stops that server. */
  id: string
  relPath: string
  status: "starting" | "running" | "error"
  url: string | null
  tool: "marimo" | "jupyter" | null
  environmentLabel: string | null
  canAddToProject: boolean
  error: string | null
}

export interface NotebookTabs {
  notebooks: NotebookPane[]
  /** Open the file's notebook tab (starting its server), or return the open one's id. */
  open: (relPath: string) => string
  /** Close the tab and stop its server. */
  close: (id: string) => void
}

/**
 * Notebook tabs of one central panel. A tab starts its server when opened and
 * stops it when closed; leaving the panel (its project or view) stops them all.
 * Tabs are not kept across restarts.
 */
export function useNotebookTabs(client: PiLabTrpcClient, workspaceId: string): NotebookTabs {
  const [notebooks, setNotebooks] = useState<NotebookPane[]>([])
  const notebooksRef = useRef<NotebookPane[]>([])
  const update = useCallback((change: (current: NotebookPane[]) => NotebookPane[]) => {
    notebooksRef.current = change(notebooksRef.current)
    setNotebooks(notebooksRef.current)
  }, [])

  const stopServer = useCallback(
    (id: string) => {
      client.notebooks.stop
        .mutate({ serverId: id })
        .catch((reason: unknown) => console.error("Could not stop the notebook server", reason))
    },
    [client],
  )

  const open = useCallback(
    (relPath: string): string => {
      const existing = notebooksRef.current.find((pane) => pane.relPath === relPath)
      if (existing) return existing.id
      const id = `notebook-${crypto.randomUUID()}`
      update((current) => [
        ...current,
        {
          id,
          relPath,
          status: "starting",
          url: null,
          tool: null,
          environmentLabel: null,
          canAddToProject: false,
          error: null,
        },
      ])
      const patch = (change: Partial<NotebookPane>) =>
        update((current) => current.map((pane) => (pane.id === id ? { ...pane, ...change } : pane)))
      client.notebooks.start.mutate({ workspaceId, relPath, serverId: id }).then(
        (started) =>
          patch({
            status: "running",
            url: started.url,
            tool: started.tool,
            environmentLabel: started.environmentLabel,
            canAddToProject: started.canAddToProject,
          }),
        (reason: unknown) =>
          patch({
            status: "error",
            error: reason instanceof Error ? reason.message : String(reason),
          }),
      )
      return id
    },
    [client, update, workspaceId],
  )

  const close = useCallback(
    (id: string) => {
      update((current) => current.filter((pane) => pane.id !== id))
      stopServer(id)
    },
    [stopServer, update],
  )

  // Leaving the panel stops every server it started.
  useEffect(
    () => () => {
      for (const pane of notebooksRef.current) stopServer(pane.id)
      notebooksRef.current = []
    },
    [stopServer],
  )

  return { notebooks, open, close }
}
