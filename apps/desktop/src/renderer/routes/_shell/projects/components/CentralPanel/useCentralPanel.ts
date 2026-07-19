import type { EditorSettings, PythonRunDestination } from "@pi-lab/local-db/editor-settings"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  type EditorBuffersApi,
  type OpenBuffer,
  useEditorBuffers,
} from "../../../../../Editor/hooks/useEditorBuffers"
import { resolveLaunchAgentId } from "../../../../../preferences/preferences"
import type { PiLabTrpcClient } from "../../../../../trpc/client"
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

export interface BelowEditorRun {
  sessionId: string
  label: string
}

export interface AgentOption {
  id: string
  label: string
  available: boolean
  executable: string
}

/** Restorable project workspace state, retained only while the app is running. */
export interface CentralPanelRestoreState {
  buffers: OpenBuffer[]
  activeRelPath: string | null
  sessions: SessionPane[]
  active: ActiveRef | null
  belowEditorRun: BelowEditorRun | null
}

export interface CentralPanelController {
  editor: EditorBuffersApi
  sessions: SessionPane[]
  active: ActiveRef | null
  /** Focus an already-open file tab. */
  selectFile: (relPath: string) => void
  /** Focus a session tab. */
  selectSession: (id: string) => void
  /** Attach or select an existing live session targeted outside this view. */
  attachSession: (session: Omit<SessionPane, "id">) => void
  /** Open a file (from the Files panel / quick-open) and make it active. */
  openFile: (relPath: string) => void
  closeFile: (relPath: string) => void
  closeSession: (id: string) => void
  /** Close whichever tab is currently active (⌘W); a no-op when none is. */
  closeActiveTab: () => void
  openAgent: () => void
  openAgentChooser: () => void
  closeAgentChooser: () => void
  launchChosenAgent: (agentId: string, workspaceMode: "main" | "worktree") => void
  agentChooserOpen: boolean
  agentOptions: AgentOption[]
  preferredAgentId: string
  openTerminal: () => void
  openNewMarkdown: () => void
  runPython: (destination?: PythonRunDestination) => void
  belowEditorRun: BelowEditorRun | null
  closeBelowEditorRun: () => void
  pendingAgent: boolean
  pendingTerminal: boolean
  pendingPython: boolean
  launchError: string | null
}

interface UseCentralPanelArgs {
  client: PiLabTrpcClient
  workspaceId: string
  projectId: string
  settings: EditorSettings
  onSaved?: (relPath: string) => void
  /** A session launched immediately before navigating here (for example from Tasks). */
  initialSession?: Omit<SessionPane, "id"> | null
  /** State retained after temporarily navigating away from this project. */
  initialState?: CentralPanelRestoreState
  onStateChange?: (state: CentralPanelRestoreState) => void
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
  initialSession,
  initialState,
  onStateChange,
}: UseCentralPanelArgs): CentralPanelController {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const editor = useEditorBuffers({
    client,
    workspaceId,
    settings,
    onSaved,
    initialBuffers: initialState?.buffers,
    initialActiveRelPath: initialState?.activeRelPath,
  })
  const initialPane = useRef<SessionPane | null>(
    !initialState && initialSession ? { ...initialSession, id: "pane-1" } : null,
  )
  const [sessions, setSessions] = useState<SessionPane[]>(
    () => initialState?.sessions ?? (initialPane.current ? [initialPane.current] : []),
  )
  const [belowEditorRun, setBelowEditorRun] = useState<BelowEditorRun | null>(
    () => initialState?.belowEditorRun ?? null,
  )
  const [agentChooserOpen, setAgentChooserOpen] = useState(false)
  const belowEditorRunRef = useRef<BelowEditorRun | null>(null)
  belowEditorRunRef.current = belowEditorRun
  const [active, setActive] = useState<ActiveRef | null>(
    () =>
      initialState?.active ??
      (initialPane.current ? { type: "session", id: initialPane.current.id } : null),
  )
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const idCounter = useRef(highestPaneNumber(sessions))

  useEffect(() => {
    onStateChange?.({
      buffers: editor.buffers,
      activeRelPath: editor.activeRelPath,
      sessions,
      active,
      belowEditorRun,
    })
  }, [active, belowEditorRun, editor.activeRelPath, editor.buffers, onStateChange, sessions])

  const startSession = useMutation(trpc.sessions.start.mutationOptions())
  const agentsQuery = useQuery(trpc.agents.list.queryOptions())
  const projectChoiceQuery = useQuery(trpc.agents.projectChoice.queryOptions({ projectId }))
  const setProjectChoice = useMutation(trpc.agents.setProjectChoice.mutationOptions())
  const spawnTerminal = useMutation(trpc.workspaces.spawnTerminal.mutationOptions())
  const runPythonFile = useMutation(trpc.python.runFile.mutationOptions())
  const killTerminal = useMutation(trpc.terminal.kill.mutationOptions())

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

  const attachSession = useCallback(
    (session: Omit<SessionPane, "id">) => {
      const existing = sessionsRef.current.find((pane) => pane.sessionId === session.sessionId)
      if (existing) {
        setActive({ type: "session", id: existing.id })
        return
      }
      const pane = { ...session, id: nextPaneId() }
      sessionsRef.current = [...sessionsRef.current, pane]
      setSessions(sessionsRef.current)
      setActive({ type: "session", id: pane.id })
    },
    [nextPaneId],
  )

  const launchAgent = useCallback(
    (agentId: string, workspaceMode: "main" | "worktree") => {
      const option = agentsQuery.data?.find((agent) => agent.id === agentId)
      startSession.mutate(
        { projectId, agentId, workspaceMode },
        {
          onSuccess: (result) => {
            const id = nextPaneId()
            setSessions((prev) => [
              ...prev,
              {
                id,
                kind: "agent",
                sessionId: result.sessionId,
                label: option?.label ?? "Agent",
                wsKind: result.kind,
              },
            ])
            setActive({ type: "session", id })
          },
        },
      )
    },
    [agentsQuery.data, projectId, startSession, nextPaneId],
  )

  const openAgent = useCallback(() => {
    const remembered = projectChoiceQuery.data?.agentId
    const option = agentsQuery.data?.find((agent) => agent.id === remembered)
    if (option?.available) {
      launchAgent(option.id, "main")
      return
    }
    setAgentChooserOpen(true)
  }, [agentsQuery.data, launchAgent, projectChoiceQuery.data?.agentId])

  const openAgentChooser = useCallback(() => setAgentChooserOpen(true), [])
  const closeAgentChooser = useCallback(() => setAgentChooserOpen(false), [])
  const launchChosenAgent = useCallback(
    (agentId: string, workspaceMode: "main" | "worktree") => {
      setProjectChoice.mutate(
        { projectId, agentId },
        {
          onSuccess: () => {
            void queryClient.invalidateQueries({
              queryKey: trpc.agents.projectChoice.queryKey({ projectId }),
            })
            setAgentChooserOpen(false)
            launchAgent(agentId, workspaceMode)
          },
        },
      )
    },
    [launchAgent, projectId, queryClient, setProjectChoice, trpc.agents.projectChoice],
  )

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

  const runPython = useCallback(
    (override?: PythonRunDestination) => {
      const relPath = editor.active?.relPath
      if (!relPath || !/\.pyi?$/i.test(relPath)) return
      const destination = override ?? settings.pythonRunDestination ?? "central"
      void editor.saveFile(relPath).then((saved) => {
        if (!saved) return
        runPythonFile.mutate(
          { workspaceId, relPath, cols: 80, rows: 24 },
          {
            onSuccess: (result) => {
              if (destination === "below-editor") {
                const previous = belowEditorRunRef.current
                const next = {
                  sessionId: result.sessionId,
                  label: `Run ${relPath.split("/").at(-1) ?? relPath}`,
                }
                belowEditorRunRef.current = next
                setBelowEditorRun(next)
                if (previous && previous.sessionId !== result.sessionId) {
                  killTerminal.mutate({ sessionId: previous.sessionId })
                }
                return
              }
              const id = nextPaneId()
              setSessions((prev) => [
                ...prev,
                {
                  id,
                  kind: "terminal",
                  sessionId: result.sessionId,
                  label: `Run ${relPath.split("/").at(-1) ?? relPath}`,
                },
              ])
              setActive({ type: "session", id })
            },
          },
        )
      })
    },
    [editor, killTerminal, nextPaneId, runPythonFile, settings.pythonRunDestination, workspaceId],
  )

  const closeBelowEditorRun = useCallback(() => {
    const current = belowEditorRunRef.current
    if (!current) return
    belowEditorRunRef.current = null
    setBelowEditorRun(null)
    killTerminal.mutate({ sessionId: current.sessionId })
  }, [killTerminal])

  return {
    editor,
    sessions,
    active,
    selectFile,
    selectSession,
    attachSession,
    openFile,
    closeFile,
    closeSession,
    closeActiveTab,
    openAgent,
    openAgentChooser,
    closeAgentChooser,
    launchChosenAgent,
    agentChooserOpen,
    agentOptions: agentsQuery.data ?? [],
    preferredAgentId: projectChoiceQuery.data?.agentId ?? resolveLaunchAgentId(),
    openTerminal,
    openNewMarkdown,
    runPython,
    belowEditorRun,
    closeBelowEditorRun,
    pendingAgent:
      startSession.isPending ||
      setProjectChoice.isPending ||
      agentsQuery.isPending ||
      projectChoiceQuery.isPending,
    pendingTerminal: spawnTerminal.isPending,
    pendingPython: runPythonFile.isPending,
    launchError:
      startSession.error?.message ??
      setProjectChoice.error?.message ??
      agentsQuery.error?.message ??
      projectChoiceQuery.error?.message ??
      spawnTerminal.error?.message ??
      runPythonFile.error?.message ??
      killTerminal.error?.message ??
      null,
  }
}

function highestPaneNumber(sessions: SessionPane[]): number {
  return sessions.reduce((highest, session) => {
    const match = /^pane-(\d+)$/.exec(session.id)
    return match ? Math.max(highest, Number(match[1])) : highest
  }, 0)
}
