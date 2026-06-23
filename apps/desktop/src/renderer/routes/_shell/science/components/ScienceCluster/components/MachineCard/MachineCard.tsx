import type { Machine } from "@skipper/local-db"
import { Badge, Button, cn, Input } from "@skipper/ui"
import { Check, Eye, EyeOff, Pencil, RefreshCw, X } from "lucide-react"
import { useState } from "react"

interface MachineCardProps {
  machine: Machine
  /** Probe this machine's reachability now. */
  onRefresh: () => void
  /** Hide / unhide this machine. */
  onToggleHidden: () => void
  /** Persist a new annotation label (or null to clear). */
  onAnnotate: (label: string | null) => void
  /** True while a status probe for this machine is in flight. */
  isRefreshing?: boolean
}

/** Map the row's tri-state reachability to a status dot + label + badge variant. */
function statusFor(machine: Machine): {
  label: string
  dot: string
  variant: "success" | "destructive" | "muted"
} {
  if (machine.lastCheckedAt == null || machine.reachable == null) {
    return { label: "not checked", dot: "bg-muted-foreground/40", variant: "muted" }
  }
  return machine.reachable
    ? { label: "reachable", dot: "bg-emerald-500", variant: "success" }
    : { label: "unreachable", dot: "bg-rose-500", variant: "destructive" }
}

/** Build the `user@hostname:port` connection line (omitting unset parts). */
function connectionLine(machine: Machine): string {
  const host = machine.hostname ?? machine.host
  const user = machine.user ? `${machine.user}@` : ""
  const port = machine.port && machine.port !== 22 ? `:${machine.port}` : ""
  return `${user}${host}${port}`
}

/**
 * One machine in the Cluster tab (AGENTS.md §1): its display name / host, the
 * connection string, a reachability status with a "Check" probe, an inline
 * annotate affordance, and a hide / unhide toggle. No dispatch / runs — that is
 * v2 (intentionally absent).
 */
export function MachineCard({
  machine,
  onRefresh,
  onToggleHidden,
  onAnnotate,
  isRefreshing,
}: MachineCardProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(machine.label ?? "")
  const status = statusFor(machine)
  const displayName = machine.label?.trim() || machine.host

  const commit = () => {
    const next = draft.trim()
    onAnnotate(next.length > 0 ? next : null)
    setEditing(false)
  }

  return (
    <div
      data-testid="machine-card"
      data-host={machine.host}
      data-hidden={machine.hidden}
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border bg-card/40 p-4",
        machine.hidden && "opacity-60",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span data-testid="machine-name" className="truncate font-semibold text-sm">
              {displayName}
            </span>
            {machine.label?.trim() ? (
              <Badge variant="outline" className="font-mono">
                {machine.host}
              </Badge>
            ) : null}
            <Badge variant="muted">
              {machine.source === "ssh-config" ? "ssh config" : "manual"}
            </Badge>
          </div>
          <div className="mt-0.5 truncate font-mono text-muted-foreground text-xs">
            {connectionLine(machine)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            data-testid="annotate-machine"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Annotate machine"
            onClick={() => {
              setDraft(machine.label ?? "")
              setEditing(true)
            }}
          >
            <Pencil />
          </Button>
          <Button
            data-testid="toggle-hidden"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={machine.hidden ? "Unhide machine" : "Hide machine"}
            onClick={onToggleHidden}
          >
            {machine.hidden ? <Eye /> : <EyeOff />}
          </Button>
        </div>
      </div>

      {editing ? (
        <div className="flex items-center gap-1.5">
          <Input
            data-testid="annotate-input"
            autoFocus
            value={draft}
            placeholder="Annotation / display name"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit()
              if (e.key === "Escape") setEditing(false)
            }}
            className="h-7 text-xs"
          />
          <Button
            data-testid="annotate-save"
            variant="outline"
            size="icon"
            className="size-7"
            aria-label="Save annotation"
            onClick={commit}
          >
            <Check />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Cancel annotation"
            onClick={() => setEditing(false)}
          >
            <X />
          </Button>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <div
          data-testid="machine-status"
          data-reachable={machine.reachable == null ? "unknown" : String(machine.reachable)}
          className="flex items-center gap-1.5 text-muted-foreground text-xs"
        >
          <span className={cn("inline-block size-2 rounded-full", status.dot)} aria-hidden />
          <span>{status.label}</span>
        </div>
        <Button
          data-testid="refresh-machine"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-xs"
          disabled={isRefreshing}
          onClick={onRefresh}
        >
          <RefreshCw className={cn(isRefreshing && "animate-spin")} />
          {isRefreshing ? "Checking…" : "Check"}
        </Button>
      </div>

      {machine.statusDetail && machine.reachable === false ? (
        <p className="cursor-text select-text break-words rounded-md bg-destructive/10 p-2 text-destructive text-xs">
          {machine.statusDetail}
        </p>
      ) : null}
    </div>
  )
}
