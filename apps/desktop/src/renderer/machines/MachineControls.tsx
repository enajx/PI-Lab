import { cn } from "@pi-lab/ui"
import { type LucideIcon, MonitorCloud, MonitorDown, MonitorOff, MonitorPause } from "lucide-react"
import { useTranslate } from "../i18n/language"
import type { ConnectionState } from "../trpc/connectionStatus"
import { localServerOff } from "./localServer"
import type { MachineSummary } from "./machines"

/** The dot colours of the status bar's connection item. */
export const CONNECTION_DOTS: Record<ConnectionState, string> = {
  connected: "bg-emerald-500",
  reconnecting: "bg-amber-500",
  disconnected: "bg-destructive",
}

export const CONNECTION_LABELS: Record<ConnectionState, string> = {
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
}

/**
 * The machine a project on another machine lives on: the monitor-cloud icon
 * and the machine's name in grey, no box; monitor-off once the machine is
 * disconnected. Projects on this Mac show none.
 */
export function MachineLabel({ name, offline }: { name: string; offline: boolean }) {
  const Icon = offline ? MonitorOff : MonitorCloud
  return (
    <span
      data-testid="machine-label"
      data-icon={offline ? "monitor-off" : "monitor-cloud"}
      title={name}
      className="inline-flex min-w-0 max-w-32 shrink-0 items-center gap-1 text-muted-foreground text-xs"
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{name}</span>
    </span>
  )
}

/** The icon of a machine in the Machines group: its connection state, or an update running. */
export function machineIcon(
  state: ConnectionState,
  updating: boolean,
): { Icon: LucideIcon; name: string } {
  if (updating) return { Icon: MonitorDown, name: "monitor-down" }
  if (state === "disconnected") return { Icon: MonitorOff, name: "monitor-off" }
  if (state === "reconnecting") return { Icon: MonitorPause, name: "monitor-pause" }
  return { Icon: MonitorCloud, name: "monitor-cloud" }
}

/**
 * Choose which machine's projects show: every machine, this Mac, or one
 * remote machine ({@link useMachineFilter}'s values).
 */
export function MachineFilter({
  machines,
  value,
  onChange,
  testId,
  className,
}: {
  machines: MachineSummary[]
  value: string
  onChange: (next: string) => void
  testId: string
  className: string
}) {
  const t = useTranslate()
  return (
    <select
      data-testid={testId}
      aria-label={t("Show projects of")}
      title={t("Show projects of")}
      data-feature-label={t("Show projects of")}
      data-feature-help={t("Show the projects of every machine, or of one machine only.")}
      value={effectiveFilter(value, machines)}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        "h-7 min-w-0 rounded-md border border-border bg-background px-1.5 text-foreground text-xs",
        className,
      )}
    >
      <option value="">{t("All machines")}</option>
      {localServerOff() ? null : <option value="local">{t("This Mac")}</option>}
      {machines.map((machine) => (
        <option key={machine.machineId} value={machine.machineId}>
          {machine.name}
        </option>
      ))}
    </select>
  )
}

/** The filter in effect: a removed machine's filter shows every machine again. */
export function effectiveFilter(value: string, machines: MachineSummary[]): string {
  const known = value === "" || value === "local" || machines.some((m) => m.machineId === value)
  return known ? value : ""
}

/** True when the (effective) filter shows the projects of `machineId` (null: this Mac). */
export function filterShows(filter: string, machineId: string | null): boolean {
  if (filter === "") return true
  return machineId === null ? filter === "local" : filter === machineId
}
