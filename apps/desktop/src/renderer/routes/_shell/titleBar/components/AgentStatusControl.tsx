import { useQuery } from "@tanstack/react-query"
import { RadioTower } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useTRPC } from "../../../../trpc/react"
import { useAgentStatus } from "../../-ProjectActivity"

const AUTH_LABELS = {
  authenticated: "Signed in",
  unauthenticated: "Sign in needed",
  missing: "Not installed",
  error: "Status check failed",
} as const

const SESSION_LABELS = {
  working: "Working",
  waiting: "Waiting",
  idle: "Idle",
  exited: "Exited",
} as const

/** Title bar view of local CLI sign-in and live agent sessions. */
export function AgentStatusControl() {
  const trpc = useTRPC()
  const [open, setOpen] = useState(false)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const environment = useQuery(
    trpc.setup.environment.queryOptions(undefined, { staleTime: 30_000, refetchInterval: 60_000 }),
  )
  const sessions = useAgentStatus()
  const attention = Boolean(
    environment.isError ||
      environment.data?.harnesses.some((agent) => agent.state !== "authenticated") ||
      sessions.data?.some((session) => session.state === "waiting"),
  )

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!hostRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  return (
    <div ref={hostRef} className="app-no-drag relative shrink-0">
      <button
        type="button"
        aria-label="Agent status"
        aria-expanded={open}
        data-testid="agent-status-control"
        data-attention={attention}
        title="Agent status"
        onClick={() => setOpen((current) => !current)}
        className="app-no-drag relative inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <RadioTower className="size-4" aria-hidden />
        {attention ? (
          <span className="absolute -top-1 -right-1 size-2 rounded-full bg-amber-500" aria-hidden />
        ) : null}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Agent status"
          data-testid="agent-status-panel"
          className="absolute top-10 right-0 z-50 w-72 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-xl"
        >
          <h2 className="font-semibold text-sm">CLI agents</h2>
          {environment.isPending ? (
            <p className="mt-2 text-muted-foreground text-xs">Checking agents…</p>
          ) : environment.isError ? (
            <p role="alert" className="mt-2 text-destructive text-xs">
              Could not check agents: {environment.error.message}
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {environment.data.harnesses.map((agent) => (
                <li key={agent.id} className="flex items-start justify-between gap-2 text-xs">
                  <span className="font-medium">{agent.label}</span>
                  <span
                    className={
                      agent.state === "authenticated"
                        ? "text-muted-foreground"
                        : "text-amber-600 dark:text-amber-400"
                    }
                  >
                    {AUTH_LABELS[agent.state]}
                    {agent.method && agent.state === "authenticated" ? ` · ${agent.method}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <h2 className="mt-4 border-border border-t pt-3 font-semibold text-sm">
            Current sessions
          </h2>
          {!sessions.data && !sessions.error ? (
            <p className="mt-2 text-muted-foreground text-xs">Checking sessions…</p>
          ) : sessions.error ? (
            <p role="alert" className="mt-2 text-destructive text-xs">
              Could not check sessions: {sessions.error?.message}
            </p>
          ) : sessions.data?.length === 0 ? (
            <p className="mt-2 text-muted-foreground text-xs">No current sessions.</p>
          ) : (
            <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto">
              {sessions.data?.map((session) => (
                <li
                  key={session.sessionId}
                  className="flex items-start justify-between gap-2 text-xs"
                >
                  <span className="min-w-0 truncate">
                    {environment.data?.harnesses.find((agent) => agent.id === session.agentId)
                      ?.label ?? session.agentId}
                    <span className="text-muted-foreground"> · {session.projectName}</span>
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {SESSION_LABELS[session.state] ?? session.state}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
