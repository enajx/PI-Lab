import { cn } from "@pi-lab/ui"
import { Server } from "lucide-react"
import { useTranslate } from "../i18n/language"
import type { ConnectionState } from "../trpc/connectionStatus"
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

/** The machine a project lives on ("This Mac" for the local server). */
export function MachineBadge({ name, className }: { name: string; className: string }) {
  return (
    <span
      data-testid="machine-badge"
      title={name}
      className={cn(
        "inline-flex max-w-32 shrink-0 items-center gap-1 rounded-sm bg-muted px-1 py-px text-[10px] text-muted-foreground",
        className,
      )}
    >
      <Server className="size-2.5 shrink-0" aria-hidden />
      <span className="truncate">{name}</span>
    </span>
  )
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
      <option value="local">{t("This Mac")}</option>
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
