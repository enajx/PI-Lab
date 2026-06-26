import { buildRrule, matchPreset, type SchedulePreset, type Weekday } from "@skipper/shared"
import { Input, Label } from "@skipper/ui"
import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { useTRPC } from "../../../../../../../trpc/react"

interface ScheduleBuilderProps {
  /** The current RRULE body (controlled). */
  value: string
  onChange: (rrule: string) => void
  /** Timezone the preview is evaluated in. */
  timezone: string
}

type Mode = SchedulePreset["kind"]

const MODE_OPTIONS: Array<{ value: Mode; label: string }> = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "custom", label: "Custom (RRULE)" },
]

const WEEKDAY_OPTIONS: Array<{ value: Weekday; label: string }> = [
  { value: "MO", label: "Mon" },
  { value: "TU", label: "Tue" },
  { value: "WE", label: "Wed" },
  { value: "TH", label: "Thu" },
  { value: "FR", label: "Fri" },
  { value: "SA", label: "Sat" },
  { value: "SU", label: "Sun" },
]

function parseHHMM(value: string): { hour: number; minute: number } {
  const [h, m] = value.split(":")
  return { hour: Number.parseInt(h ?? "9", 10) || 0, minute: Number.parseInt(m ?? "0", 10) || 0 }
}

function toHHMM(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}

/**
 * Schedule builder for the create/edit form (AGENTS.md "Scope"): a simple preset
 * picker (Hourly / Daily / Weekdays / Weekly with a time, or a specific weekday)
 * that compiles to an RRULE, plus a Custom mode for raw RRULE editing. A live,
 * human-readable preview ("Daily at 9:00 AM") and the next few fire times are
 * fetched from the pure recurrence engine via `automations.previewSchedule`.
 *
 * The component is controlled by the RRULE string: it derives the active preset
 * from the current value (`matchPreset`) so editing stays in the simple builder
 * whenever the rule fits an authored shape, and falls back to Custom otherwise.
 */
export function ScheduleBuilder({ value, onChange, timezone }: ScheduleBuilderProps) {
  const trpc = useTRPC()
  const matched = useMemo(() => matchPreset(value), [value])
  // The active mode is normally derived from the rule, but "Custom" is sticky:
  // a raw rule that happens to match a preset (e.g. the daily default) must keep
  // showing the RRULE editor once the user explicitly picks Custom.
  const [forceCustom, setForceCustom] = useState(false)
  const preset: SchedulePreset = forceCustom ? { kind: "custom", rule: value } : matched
  const mode: Mode = preset.kind

  const preview = useQuery(
    trpc.automations.previewSchedule.queryOptions({ recurrenceRule: value, timezone }),
  )

  const setMode = (nextMode: Mode) => {
    setForceCustom(nextMode === "custom")
    switch (nextMode) {
      case "hourly":
        onChange(buildRrule({ kind: "hourly" }))
        break
      case "daily":
        onChange(buildRrule({ kind: "daily", hour: 9, minute: 0 }))
        break
      case "weekdays":
        onChange(buildRrule({ kind: "weekdays", hour: 9, minute: 0 }))
        break
      case "weekly":
        onChange(buildRrule({ kind: "weekly", day: "MO", hour: 9, minute: 0 }))
        break
      case "custom":
        onChange(value || "FREQ=DAILY;BYHOUR=9;BYMINUTE=0")
        break
    }
  }

  const time =
    preset.kind === "daily" || preset.kind === "weekdays" || preset.kind === "weekly"
      ? toHHMM(preset.hour, preset.minute)
      : "09:00"

  return (
    <div className="flex flex-col gap-3" data-testid="schedule-builder">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="schedule-mode" className="text-muted-foreground text-xs">
          Repeat
        </Label>
        <select
          id="schedule-mode"
          data-testid="schedule-mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as Mode)}
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {MODE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {(preset.kind === "daily" || preset.kind === "weekdays" || preset.kind === "weekly") && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="schedule-time" className="text-muted-foreground text-xs">
            Time
          </Label>
          <Input
            id="schedule-time"
            data-testid="schedule-time"
            type="time"
            value={time}
            onChange={(e) => {
              const { hour, minute } = parseHHMM(e.target.value)
              if (preset.kind === "weekly") {
                onChange(buildRrule({ kind: "weekly", day: preset.day, hour, minute }))
              } else {
                onChange(buildRrule({ kind: preset.kind, hour, minute }))
              }
            }}
          />
        </div>
      )}

      {preset.kind === "weekly" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="schedule-weekday" className="text-muted-foreground text-xs">
            Day of week
          </Label>
          <select
            id="schedule-weekday"
            data-testid="schedule-weekday"
            value={preset.day}
            onChange={(e) =>
              onChange(
                buildRrule({
                  kind: "weekly",
                  day: e.target.value as Weekday,
                  hour: preset.hour,
                  minute: preset.minute,
                }),
              )
            }
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {WEEKDAY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {preset.kind === "custom" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="schedule-rrule" className="text-muted-foreground text-xs">
            RRULE
          </Label>
          <Input
            id="schedule-rrule"
            data-testid="schedule-rrule"
            value={value}
            placeholder="FREQ=DAILY;BYHOUR=9;BYMINUTE=0"
            onChange={(e) => onChange(e.target.value)}
            className="font-mono"
          />
        </div>
      )}

      <div
        data-testid="schedule-preview"
        data-valid={preview.data?.valid ?? false}
        className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs"
      >
        {preview.data?.valid ? (
          <>
            <p className="font-medium text-foreground" data-testid="schedule-preview-summary">
              {preview.data.summary}
            </p>
            {preview.data.upcoming.length > 0 ? (
              <p className="mt-0.5 text-muted-foreground">
                Next: {new Date(preview.data.upcoming[0] ?? 0).toLocaleString()}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-destructive" data-testid="schedule-preview-invalid">
            Enter a valid recurrence rule.
          </p>
        )}
      </div>
    </div>
  )
}
