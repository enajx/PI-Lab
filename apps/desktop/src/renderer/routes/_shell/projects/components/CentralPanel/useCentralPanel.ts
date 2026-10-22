import type { EditorSettings, PythonRunDestination } from "@pi-lab/local-db/editor-settings"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  type EditorBuffersApi,
  type OpenBuffer,
  useEditorBuffers,
} from "../../../../../Editor/hooks/useEditorBuffers"
import type { RetainedBuffers } from "../../../../../Editor/hooks/useEditorBuffers/useEditorBuffers"
import { resolveLaunchAgentId, useDefaultAgentId } from "../../../../../preferences/preferences"
import type { PiLabTrpcClient } from "../../../../../trpc/client"
import { useTRPC } from "../../../../../trpc/react"

/** Which kind of pane the central panel is currently showing. */
export type ActiveRef = { type: "file"; relPath: string } | { type: "session"; id: string }

/** Enough information to recreate a tab after the PTY daemon was lost on restart. */
export type SessionLaunchConfig =
  | { type: "terminal" }
  | { type: "agent"; agentId: string; workspaceMode: "policy" | "main" | "worktree" }
  | { type: "python"; relPath: string }
  | { type: "auto-research" }

/** A running agent/terminal pane (one tab) attached by `sessionId`. */
export interface SessionPane {
  id: string
  kind: "agent" | "terminal"
  sessionId: string
  label: string
  /** For agents: the worktree-policy outcome surfaced as a kind badge. */
  wsKind?: "branch" | "worktree"
  /** Saved launch configuration used only when the recorded PTY is no longer live. */
  launch?: SessionLaunchConfig
}

export interface BelowEditorRun {
  sessionId: string
  label: string
  /** Python source used to recreate this terminal when its PTY no longer exists. */
  relPath?: string
}

export interface AgentOption {
  id: string
  label: string
  available: boolean
  executable: string
}

/** Restorable project workspace state, retained only while the app is running. */
export interface CentralPanelRestoreState {
  omittedBuffers?: import("../../-workspaceRecovery").OmittedBuffer[]
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
  onBuffersChange?: (buffers: OpenBuffer[]) => void
  retainedBuffers?: RetainedBuffers
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
  onBuffersChange,
  retainedBuffers,
}: UseCentralPanelArgs): CentralPanelController {
  const trpc = useTRPC()
  const [defaultAgentId, , defaultAgentError, defaultAgentPending] = useDefaultAgentId()
  const editor = useEditorBuffers({
    client,
    workspaceId,
    settings,
    onSaved,
    initialBuffers: initialState?.buffers,
    initialActiveRelPath: initialState?.activeRelPath,
    onBuffersChange,
    retainedBuffers,
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
  const [restorationError, setRestorationError] = useState<string | null>(null)
  const belowEditorRunRef = useRef<BelowEditorRun | null>(null)
  belowEditorRunRef.current = belowEditorRun
  const [active, setActive] = useState<ActiveRef | null>(
    () =>
      initialState?.active ??
      (initialPane.current ? { type: "session", id: initialPane.current.id } : null),
  )
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const updateSessions = useCallback((update: (previous: SessionPane[]) => SessionPane[]) => {
    const next = update(sessionsRef.current)
    sessionsRef.current = next
    setSessions(next)
  }, [])
  const idCounter = useRef(highestPaneNumber(sessions))

  // biome-ignore lint/correctness/useExhaustiveDependencies: Buffer changes trigger publication; the synchronous accessor supplies the latest revision.
  useEffect(() => {
    onStateChange?.({
      buffers: editor.bufferAccess.read(),
      activeRelPath: editor.activeRelPath,
      sessions,
      active,
      belowEditorRun,
    })
  }, [
    active,
    belowEditorRun,
    editor.activeRelPath,
    editor.buffers,
    editor.bufferAccess.read,
    onStateChange,
    sessions,
  ])

  const restoringPaths = useRef(false)
  useEffect(() => {
    if (!workspaceId || restoringPaths.current) return
    const paths = (initialState?.omittedBuffers ?? []).filter((buffer) => !buffer.untitled)
    if (paths.length === 0) return
    restoringPaths.current = true
    let live = true
    void (async () => {
      for (const descriptor of paths) {
        if (!live) return
        await editor.openFile(descriptor.relPath)
      }
      if (live && initialState?.activeRelPath) editor.setActiveRelPath(initialState.activeRelPath)
    })()
    return () => {
      live = false
      restoringPaths.current = false
    }
  }, [workspaceId, initialState, editor.openFile, editor.setActiveRelPath])

  const startSession = useMutation(trpc.sessions.start.mutationOptions())
  const agentsQuery = useQuery(trpc.agents.list.queryOptions(undefined, { staleTime: 0 }))
  const projectChoiceQuery = useQuery(
    trpc.agents.projectChoice.queryOptions({ projectId }, { staleTime: 0 }),
  )
  const spawnTerminal = useMutation(trpc.workspaces.spawnTerminal.mutationOptions())
  const runPythonFile = useMutation(trpc.python.runFile.mutationOptions())
  const killTerminal = useMutation(trpc.terminal.kill.mutationOptions())

  const restorationGeneration = useRef(0)
  useEffect(() => {
    const panes = initialState?.sessions ?? []
    const savedBelowEditorRun = initialState?.belowEditorRun ?? null
    if ((panes.length === 0 && !savedBelowEditorRun) || !workspaceId) return

    const generation = restorationGeneration.current + 1
    restorationGeneration.current = generation
    const createdSessionIds = new Set<string>()
    const isCurrent = (): boolean => restorationGeneration.current === generation
    const reportError = (message: string): void => {
      if (isCurrent()) setRestorationError(message)
    }
    const killUnclaimedSessions = (): void => {
      for (const sessionId of createdSessionIds) {
        void client.terminal.kill.mutate({ sessionId }).catch((error: unknown) => {
          console.warn("Could not stop an unclaimed restored terminal", sessionId, error)
        })
      }
      createdSessionIds.clear()
    }

    void client.terminal.list
      .query()
      .then(async (liveSessions) => {
        const liveIds = new Set(
          liveSessions.filter((session) => session.alive).map((session) => session.id),
        )
        const restorePane = async (pane: SessionPane): Promise<SessionPane | null> => {
          if (liveIds.has(pane.sessionId)) return pane
          if (!pane.launch) {
            reportError(
              `Could not restore ${pane.label}: its saved launch configuration is unavailable.`,
            )
            return null
          }

          if (pane.launch.type === "terminal") {
            const result = await client.workspaces.spawnTerminal.mutate({
              workspaceId,
              cols: 80,
              rows: 24,
            })
            createdSessionIds.add(result.sessionId)
            return { ...pane, sessionId: result.sessionId }
          }
          if (pane.launch.type === "python") {
            const result = await client.python.runFile.mutate({
              workspaceId,
              relPath: pane.launch.relPath,
              cols: 80,
              rows: 24,
            })
            createdSessionIds.add(result.sessionId)
            return { ...pane, sessionId: result.sessionId }
          }
          if (pane.launch.type === "auto-research") {
            const result = await client.sessions.startAutoResearch.mutate({ projectId })
            createdSessionIds.add(result.sessionId)
            return { ...pane, sessionId: result.sessionId, wsKind: result.kind }
          }
          const result = await client.sessions.start.mutate({
            projectId,
            agentId: pane.launch.agentId,
            workspaceMode: pane.launch.workspaceMode,
          })
          createdSessionIds.add(result.sessionId)
          return { ...pane, sessionId: result.sessionId, wsKind: result.kind }
        }
        const restored = await Promise.all(
          panes.map((pane) =>
            restorePane(pane).catch((error: unknown) => {
              reportError(
                `Could not restore ${pane.label}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              )
              return null
            }),
          ),
        )
        const available = restored.filter((pane): pane is SessionPane => pane !== null)
        let nextBelowEditorRun = savedBelowEditorRun
        if (savedBelowEditorRun && !liveIds.has(savedBelowEditorRun.sessionId)) {
          if (savedBelowEditorRun.relPath) {
            await client.python.runFile
              .mutate({
                workspaceId,
                relPath: savedBelowEditorRun.relPath,
                cols: 80,
                rows: 24,
              })
              .then((result) => {
                createdSessionIds.add(result.sessionId)
                nextBelowEditorRun = { ...savedBelowEditorRun, sessionId: result.sessionId }
              })
              .catch((error: unknown) => {
                nextBelowEditorRun = null
                reportError(
                  `Could not restore ${savedBelowEditorRun.label}: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                )
              })
          } else {
            nextBelowEditorRun = null
            reportError(
              `Could not restore ${savedBelowEditorRun.label}: its saved launch configuration is unavailable.`,
            )
          }
        }
        if (!isCurrent()) {
          killUnclaimedSessions()
          return
        }
        const originalById = new Map(panes.map((pane) => [pane.id, pane]))
        const restoredById = new Map(available.map((pane) => [pane.id, pane]))
        const next = sessionsRef.current.flatMap((pane) => {
          const original = originalById.get(pane.id)
          if (!original || original.sessionId !== pane.sessionId) return [pane]
          const restored = restoredById.get(pane.id)
          return restored ? [restored] : []
        })
        sessionsRef.current = next
        setSessions(next)
        if (belowEditorRunRef.current === savedBelowEditorRun) {
          belowEditorRunRef.current = nextBelowEditorRun
          setBelowEditorRun(nextBelowEditorRun)
        }
        for (const pane of next) createdSessionIds.delete(pane.sessionId)
        if (belowEditorRunRef.current) createdSessionIds.delete(belowEditorRunRef.current.sessionId)
        killUnclaimedSessions()
        setActive((current) => {
          if (current?.type !== "session") return current
          return next.some((pane) => pane.id === current.id) ? current : null
        })
      })
      .catch((error: unknown) => {
        reportError(
          `Could not restore terminal and agent tabs: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        killUnclaimedSessions()
      })
    return () => {
      if (isCurrent()) restorationGeneration.current += 1
      killUnclaimedSessions()
    }
  }, [client, initialState?.belowEditorRun, initialState?.sessions, projectId, workspaceId])

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
        const next = editor.bufferAccess
          .read()
          .filter((buffer) => buffer.relPath !== relPath)
          .at(-1)
        return next ? { type: "file", relPath: next.relPath } : null
      })
    },
    [editor],
  )

  const closeSession = useCallback(
    (id: string) => {
      const closing = sessionsRef.current.find((session) => session.id === id)
      if (closing) killTerminal.mutate({ sessionId: closing.sessionId })
      sessionsRef.current = sessionsRef.current.filter((session) => session.id !== id)
      setSessions(sessionsRef.current)
      setActive((cur) => (cur?.type === "session" && cur.id === id ? null : cur))
    },
    [killTerminal],
  )

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
    (agentId: string, workspaceMode: "policy" | "main" | "worktree") => {
      const option = agentsQuery.data?.find((agent) => agent.id === agentId)
      startSession.mutate(
        { projectId, agentId, workspaceMode },
        {
          onSuccess: (result) => {
            const id = nextPaneId()
            updateSessions((prev) => [
              ...prev,
              {
                id,
                kind: "agent",
                sessionId: result.sessionId,
                label: option?.label ?? "Agent",
                wsKind: result.kind,
                launch: { type: "agent", agentId, workspaceMode },
              },
            ])
            setActive({ type: "session", id })
          },
        },
      )
    },
    [agentsQuery.data, projectId, startSession, nextPaneId, updateSessions],
  )

  const openAgent = useCallback(() => {
    const remembered = projectChoiceQuery.data?.agentId ?? resolveLaunchAgentId(defaultAgentId)
    const option = agentsQuery.data?.find((agent) => agent.id === remembered)
    if (option?.available) {
      launchAgent(option.id, "policy")
      return
    }
    setAgentChooserOpen(true)
  }, [agentsQuery.data, defaultAgentId, launchAgent, projectChoiceQuery.data?.agentId])

  const openAgentChooser = useCallback(() => setAgentChooserOpen(true), [])
  const closeAgentChooser = useCallback(() => setAgentChooserOpen(false), [])
  const launchChosenAgent = useCallback(
    (agentId: string, workspaceMode: "main" | "worktree") => {
      setAgentChooserOpen(false)
      launchAgent(agentId, workspaceMode)
    },
    [launchAgent],
  )

  const openTerminal = useCallback(() => {
    spawnTerminal.mutate(
      { workspaceId, cols: 80, rows: 24 },
      {
        onSuccess: (result) => {
          const id = nextPaneId()
          updateSessions((prev) => [
            ...prev,
            {
              id,
              kind: "terminal",
              sessionId: result.sessionId,
              label: "Terminal",
              launch: { type: "terminal" },
            },
          ])
          setActive({ type: "session", id })
        },
      },
    )
  }, [workspaceId, spawnTerminal, nextPaneId, updateSessions])

  const openNewMarkdown = useCallback(() => {
    let name = "untitled.md"
    let i = 1
    while (editor.tabs.some((tab) => tab.relPath === name)) {
      name = `untitled-${i++}.md`
    }
    editor.openUntitled(name)
    setActive({ type: "file", relPath: name })
  }, [editor, editor.tabs])

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
                  relPath,
                }
                belowEditorRunRef.current = next
                setBelowEditorRun(next)
                if (previous && previous.sessionId !== result.sessionId) {
                  killTerminal.mutate({ sessionId: previous.sessionId })
                }
                return
              }
              const id = nextPaneId()
              updateSessions((prev) => [
                ...prev,
                {
                  id,
                  kind: "terminal",
                  sessionId: result.sessionId,
                  label: `Run ${relPath.split("/").at(-1) ?? relPath}`,
                  launch: { type: "python", relPath },
                },
              ])
              setActive({ type: "session", id })
            },
          },
        )
      })
    },
    [
      editor,
      killTerminal,
      nextPaneId,
      runPythonFile,
      settings.pythonRunDestination,
      workspaceId,
      updateSessions,
    ],
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
    preferredAgentId: projectChoiceQuery.data?.agentId ?? resolveLaunchAgentId(defaultAgentId),
    openTerminal,
    openNewMarkdown,
    runPython,
    belowEditorRun,
    closeBelowEditorRun,
    pendingAgent:
      defaultAgentPending ||
      startSession.isPending ||
      agentsQuery.isPending ||
      projectChoiceQuery.isPending,
    pendingTerminal: spawnTerminal.isPending,
    pendingPython: runPythonFile.isPending,
    launchError:
      restorationError ??
      defaultAgentError ??
      startSession.error?.message ??
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
