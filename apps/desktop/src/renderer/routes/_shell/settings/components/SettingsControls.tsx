import { cn } from "@pi-lab/ui"
import type { ReactNode } from "react"

/** A titled settings section with its rows in a bordered, divided card. */
export function SettingsSection({
  title,
  description,
  testId,
  children,
}: {
  title: string
  description?: ReactNode
  testId?: string
  children: ReactNode
}) {
  return (
    <section data-testid={testId} className="flex max-w-2xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold text-base text-foreground">{title}</h2>
        {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
      </div>
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {children}
      </div>
    </section>
  )
}

/** A label + supporting text on the left of a settings row. */
function FieldLabel({ label, description }: { label: ReactNode; description?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-foreground text-sm">{label}</span>
      {description ? <span className="text-muted-foreground text-xs">{description}</span> : null}
    </div>
  )
}

/** An on/off switch row. */
export function ToggleField({
  testId,
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  testId: string
  label: ReactNode
  description?: ReactNode
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <FieldLabel label={label} description={description} />
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={typeof label === "string" ? label : undefined}
        data-feature-label={typeof label === "string" ? label : undefined}
        data-feature-help={typeof description === "string" ? description : undefined}
        data-testid={testId}
        data-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
          checked ? "bg-primary" : "bg-muted",
          disabled ? "opacity-50" : "",
        )}
      >
        <span
          className={cn(
            "inline-block size-4 transform rounded-full bg-background shadow transition-transform",
            checked ? "translate-x-4" : "translate-x-0.5",
          )}
        />
      </button>
    </div>
  )
}

/** A labelled multi-line text row. The value is committed on change (controlled). */
export function TextAreaField({
  testId,
  label,
  description,
  value,
  placeholder,
  onChange,
}: {
  testId: string
  label: ReactNode
  description?: ReactNode
  value: string
  placeholder?: string
  onChange: (next: string) => void
}) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <FieldLabel label={label} description={description} />
      <textarea
        data-testid={testId}
        aria-label={typeof label === "string" ? label : undefined}
        data-feature-label={typeof label === "string" ? label : undefined}
        data-feature-help={typeof description === "string" ? description : undefined}
        value={value}
        placeholder={placeholder}
        rows={3}
        onChange={(event) => onChange(event.target.value)}
        className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-foreground text-sm outline-none"
      />
    </div>
  )
}

/** A single option in a {@link SelectField}. */
type SelectOption = { value: string; label: string }

/**
 * A labelled native select row. Pass a flat `options` list, or `groups` to render
 * `<optgroup>` blocks (used by the editor theme picker to split Light/Dark); when
 * both are given, `groups` wins.
 */
export function SelectField({
  testId,
  label,
  description,
  value,
  options,
  groups,
  onChange,
}: {
  testId: string
  label: ReactNode
  description?: ReactNode
  value: string
  options?: SelectOption[]
  groups?: { label: string; options: SelectOption[] }[]
  onChange: (next: string) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <FieldLabel label={label} description={description} />
      <select
        data-testid={testId}
        aria-label={typeof label === "string" ? label : undefined}
        data-feature-label={typeof label === "string" ? label : undefined}
        data-feature-help={typeof description === "string" ? description : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="shrink-0 rounded-md border border-border bg-background px-2 py-1 text-foreground text-sm outline-none"
      >
        {groups
          ? groups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ))
          : (options ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
      </select>
    </div>
  )
}
