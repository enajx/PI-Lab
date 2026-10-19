import type { Machine } from "@pi-lab/local-db"
import { Badge, Button, cn, Input } from "@pi-lab/ui"
import { Check, Cpu, Eye, EyeOff, Loader2, Pencil, Radar, X } from "lucide-react"
import { useState } from "react"
import { useInterfaceLanguage, useTranslate } from "../../../../../../../i18n/language"
import type { RouterOutputs } from "../../../../../../../trpc/types"

/** Transient GPU / CPU telemetry from the most recent probe (not persisted). */
export type MachineTelemetry = Pick<
  RouterOutputs["science"]["cluster"]["refreshStatus"],
  "gpus" | "cpuUsage"
>

type GpuSnapshot = NonNullable<MachineTelemetry["gpus"]>[number]

/** A GPU at or above this compute utilization counts as "busy" in the summary. */
const GPU_BUSY_PERCENT = 20

interface MachineCardProps {
  machine: Machine
  /** Live GPU / CPU telemetry from the last probe (omitted before any probe). */
  telemetry?: MachineTelemetry
  /** Projects currently assigned to this machine; empty until remote dispatch is available. */
  runningProjects: readonly string[]
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
    ? { label: "online", dot: "bg-emerald-500", variant: "success" }
    : { label: "offline", dot: "bg-rose-500", variant: "destructive" }
}

/** Build the `user@hostname:port` connection line (omitting unset parts). */
function connectionLine(machine: Machine): string {
  const host = machine.hostname ?? machine.host
  const user = machine.user ? `${machine.user}@` : ""
  const port = machine.port && machine.port !== 22 ? `:${machine.port}` : ""
  return `${user}${host}${port}`
}

/** Round a util/percentage to a whole number for compact display. */
function pct(value: number): number {
  return Math.round(value)
}

/**
 * One machine in the Cluster tab: its display name / host, the
 * connection string, a reachability status with a "Check" probe, an inline
 * annotate affordance, and a hide / unhide toggle. When a probe has returned
 * telemetry it also renders the host's per-GPU usage and CPU load. No dispatch /
 * runs — that is v2 (intentionally absent).
 */
export function MachineCard({
  machine,
  telemetry,
  runningProjects,
  onRefresh,
  onToggleHidden,
  onAnnotate,
  isRefreshing,
}: MachineCardProps) {
  const t = useTranslate()
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
        "flex h-full flex-col gap-2 rounded-lg border border-border bg-card/40 p-4",
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
            aria-label={t("Annotate machine")}
            data-feature-help={t("Set a friendly display name while keeping the SSH host alias")}
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
            aria-label={machine.hidden ? t("Unhide machine") : t("Hide machine")}
            data-feature-help={
              machine.hidden
                ? t("Restore this machine to the normal cluster view")
                : t("Remove this machine from the normal cluster view")
            }
            onClick={onToggleHidden}
          >
            {machine.hidden ? <EyeOff /> : <Eye />}
          </Button>
        </div>
      </div>

      {editing ? (
        <div className="flex items-center gap-1.5">
          <Input
            data-testid="annotate-input"
            autoFocus
            value={draft}
            placeholder={t("Annotation / display name")}
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
            aria-label={t("Save annotation")}
            onClick={commit}
          >
            <Check />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t("Cancel annotation")}
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
          className="group/err relative flex items-center gap-1.5 text-muted-foreground text-xs"
        >
          <span className={cn("inline-block size-2 rounded-full", status.dot)} aria-hidden />
          <span>{t(status.label)}</span>
          {machine.reachable === false && machine.statusDetail ? (
            <div
              data-testid="machine-status-detail"
              className="absolute top-full left-0 z-50 mt-1 hidden w-72 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-xl group-hover/err:block"
            >
              <p className="cursor-text select-text break-words text-xs">{machine.statusDetail}</p>
            </div>
          ) : null}
        </div>
        <Button
          data-testid="refresh-machine"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-xs"
          disabled={isRefreshing}
          data-feature-help={t(
            "Connect over SSH and refresh this machine's reachability and hardware usage",
          )}
          onClick={onRefresh}
        >
          {isRefreshing ? <Loader2 className="animate-spin" /> : <Radar />}
          {isRefreshing ? t("Checking…") : t("Check")}
        </Button>
      </div>

      {telemetry && machine.reachable === true ? (
        <MachineTelemetryPanel telemetry={telemetry} checkedAt={machine.lastCheckedAt} />
      ) : null}

      <div
        data-testid="machine-running-projects"
        className="mt-auto flex min-h-7 items-center gap-1.5 border-border/60 border-t pt-2"
      >
        {runningProjects.map((project) => (
          <Badge key={project} variant="muted">
            {project}
          </Badge>
        ))}
      </div>
    </div>
  )
}

/**
 * The telemetry block for a reachable machine: a CPU-load line, a "N/M GPUs busy"
 * summary, and one row per GPU (name, a utilization bar, and used/total memory).
 * Falls back to "No GPUs reported" when the host returned no GPUs.
 */
function MachineTelemetryPanel({
  telemetry,
  checkedAt,
}: {
  telemetry: MachineTelemetry
  checkedAt: number | null
}) {
  const t = useTranslate()
  const [language] = useInterfaceLanguage()
  const gpus = telemetry.gpus ?? []
  const busy = gpus.filter((gpu) => gpu.utilization >= GPU_BUSY_PERCENT).length

  return (
    <div
      data-testid="machine-telemetry"
      className="flex flex-col gap-1.5 border-border/60 border-t pt-2"
    >
      <div className="flex items-center justify-between gap-2 text-muted-foreground text-xs">
        <span data-testid="gpu-summary">
          {gpus.length > 0 ? `${busy}/${gpus.length} ${t("GPUs busy")}` : t("No GPUs reported")}
        </span>
        {telemetry.cpuUsage != null ? (
          <span data-testid="cpu-usage" className="flex items-center gap-1">
            <Cpu className="size-3" aria-hidden />
            CPU {pct(telemetry.cpuUsage)}%
          </span>
        ) : null}
      </div>
      {checkedAt != null ? (
        <p data-testid="machine-checked-at" className="text-muted-foreground/80 text-xs">
          {t("Checked")}{" "}
          {new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(
            new Date(checkedAt),
          )}
        </p>
      ) : null}
      {gpus.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {gpus.map((gpu) => (
            <GpuRow key={gpu.index} gpu={gpu} />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** One GPU's row: name, a utilization bar (busy ⇒ amber), and used/total memory. */
function GpuRow({ gpu }: { gpu: GpuSnapshot }) {
  const utilization = Math.max(0, Math.min(100, gpu.utilization))
  const busy = utilization >= GPU_BUSY_PERCENT
  return (
    <li
      data-testid="gpu-row"
      data-gpu-index={gpu.index}
      className="grid grid-cols-[minmax(0,1fr)_4rem_2.5rem_auto] items-center gap-2 text-xs"
    >
      <span className="flex min-w-0 items-center text-muted-foreground" title={gpu.name}>
        <span className="w-4 shrink-0 text-right tabular-nums">{gpu.index}</span>
        <span className="shrink-0">:&nbsp;</span>
        <span className="truncate">{gpu.name}</span>
      </span>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted-foreground/15">
        <div
          className={cn("h-full rounded-full", busy ? "bg-amber-500" : "bg-emerald-500")}
          style={{ width: `${utilization}%` }}
          aria-hidden
        />
      </div>
      <span className="text-right tabular-nums text-muted-foreground">{pct(gpu.utilization)}%</span>
      <span className="shrink-0 font-mono text-muted-foreground/80 text-[11px]">
        {gpu.memUsed}/{gpu.memTotal} MiB
      </span>
    </li>
  )
}
