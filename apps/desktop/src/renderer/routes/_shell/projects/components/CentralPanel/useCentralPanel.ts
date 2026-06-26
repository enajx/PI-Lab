import type { EditorSettings } from "@skipper/local-db"
import { useMutation } from "@tanstack/react-query"
import { useCallback, useRef, useState } from "react"
import {
  type EditorBuffersApi,
  useEditorBuffers,
} from "../../../../../Editor/hooks/useEditorBuffers"
import { resolveLaunchAgentId } from "../../../../../preferences/preferences"
import type { SkipperTrpcClient } from "../../../../../trpc/client"
import { useTRPC } from "../../../../../trpc/react"

/** Which kind of pane the central panel is currently showing. */
export type ActiveRef = { type: "file"; relPath: string } | { type: "session"; id: string }

/** A running agent/terminal pane (one tab) attached by `sessionId`. */
export interface SessionPane {
  id: string
  kind: "agent" | "terminal"
  sessionId: string
  label: string
  /** For agents: the worktree-policy outcome surfaced as a kind badge. */
  wsKind?: "branch" | "worktree"
}

export interface CentralPanelController {
  editor: EditorBuffersApi
  sessions: SessionPane[]
  active: ActiveRef | null
  /** Focus an already-open file tab. */
  selectFile: (relPath: string) => void
  /** Focus a session tab. */
  selectSession: (id: string) => void
  /** Open a file (from the Files panel / quick-open) and make it active. */
  openFile: (relPath: string) => void
  closeFile: (relPath: string) => void
  closeSession: (id: string) => void
  /** Close whichever tab is currently active (⌘W); a no-op when none is. */
  closeActiveTab: () => void
  openAgent: () => void
  openTerminal: () => void
  openNewMarkdown: () => void
  pendingAgent: boolean
  pendingTerminal: boolean
  launchError: string | null
}

interface UseCentralPanelArgs {
  client: SkipperTrpcClient
  workspaceId: string
  projectId: string
  settings: EditorSettings
  onSaved?: (relPath: string) => void
}

/**
 * Controller for the project view's central panel: a tab set mixing the editor's
 * open files (top-level tabs) with running agent/terminal sessions, plus a single
 * "active" selector so exactly one pane fills the panel. Composes
 * {@link useEditorBuffers} for files; opens agents via `sessions.start` and plain
 * terminals via `workspaces.spawnTerminal` (both attach by the returned
 * `sessionId`). Lives at the project-view level so the right-sidebar Files panel
 * can drive {@link CentralPanelController.openFile} too.
 */
export function useCentralPanel({
  client,
  workspaceId,
  projectId,
  settings,
  onSaved,
}: UseCentralPanelArgs): CentralPanelController {
  const trpc = useTRPC()
  const editor = useEditorBuffers({ client, workspaceId, settings, onSaved })
  const [sessions, setSessions] = useState<SessionPane[]>([])
  const [active, setActive] = useState<ActiveRef | null>(null)
  const idCounter = useRef(0)

  const startSession = useMutation(trpc.sessions.start.mutationOptions())
  const spawnTerminal = useMutation(trpc.workspaces.spawnTerminal.mutationOptions())

  const selectFile = useCallback(
    (relPath: string) => {
      editor.setActiveRelPath(relPath)
      setActive({ type: "file", relPath })
    },
    [editor],
  )

  const selectSession = useCallback((id: string) => setActive({ type: "session", id }), [])

  const openFile = useCallback(
    (relPath: string) => {
      void editor.openFile(relPath)
      setActive({ type: "file", relPath })
    },
    [editor],
  )

  const closeFile = useCallback(
    (relPath: string) => {
      editor.closeFile(relPath)
      setActive((cur) => {
        if (cur?.type !== "file" || cur.relPath !== relPath) return cur
        // Mirror the editor's own fallback: focus the last remaining buffer (or
        // the launcher when none are left), not always the launcher.
        const next = editor.buffers.filter((buffer) => buffer.relPath !== relPath).at(-1)
        return next ? { type: "file", relPath: next.relPath } : null
      })
    },
    [editor],
  )

  const closeSession = useCallback((id: string) => {
    setSessions((prev) => prev.filter((session) => session.id !== id))
    setActive((cur) => (cur?.type === "session" && cur.id === id ? null : cur))
  }, [])

  // Close the active tab (bound to ⌘W in the project view). Routes to the same
  // close path the tab's "x" button uses; no-op when nothing is active.
  const closeActiveTab = useCallback(() => {
    if (!active) return
    if (active.type === "file") closeFile(active.relPath)
    else closeSession(active.id)
  }, [active, closeFile, closeSession])

  // Monotonic pane ids (no Math.random / Date.now needed for uniqueness).
  const nextPaneId = useCallback(() => {
    idCounter.current += 1
    return `pane-${idCounter.current}`
  }, [])

  const openAgent = useCallback(() => {
    startSession.mutate(
      { projectId, agentId: resolveLaunchAgentId() },
      {
        onSuccess: (result) => {
          const id = nextPaneId()
          setSessions((prev) => [
            ...prev,
            { id, kind: "agent", sessionId: result.sessionId, label: "Agent", wsKind: result.kind },
          ])
          setActive({ type: "session", id })
        },
      },
    )
  }, [projectId, startSession, nextPaneId])

  const openTerminal = useCallback(() => {
    spawnTerminal.mutate(
      { workspaceId, cols: 80, rows: 24 },
      {
        onSuccess: (result) => {
          const id = nextPaneId()
          setSessions((prev) => [
            ...prev,
            { id, kind: "terminal", sessionId: result.sessionId, label: "Terminal" },
          ])
          setActive({ type: "session", id })
        },
      },
    )
  }, [workspaceId, spawnTerminal, nextPaneId])

  const openNewMarkdown = useCallback(() => {
    let name = "untitled.md"
    let i = 1
    while (editor.tabs.some((tab) => tab.relPath === name)) {
      name = `untitled-${i++}.md`
    }
    openFile(name)
  }, [editor.tabs, openFile])

  return {
    editor,
    sessions,
    active,
    selectFile,
    selectSession,
    openFile,
    closeFile,
    closeSession,
    closeActiveTab,
    openAgent,
    openTerminal,
    openNewMarkdown,
    pendingAgent: startSession.isPending,
    pendingTerminal: spawnTerminal.isPending,
    launchError: startSession.error?.message ?? spawnTerminal.error?.message ?? null,
  }
}
