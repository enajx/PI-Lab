import { cn } from "@pi-lab/ui"
import { Check, ChevronDown } from "lucide-react"
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react"
import { usePopupDismiss } from "../../../../../components/usePopupDismiss"

/** One project the picker offers. */
export interface ProjectPickerOption {
  id: string
  name: string
}

interface ProjectPickerProps {
  /** Stable test id on the trigger button (e.g. `tasks-project-select`). */
  testId: string
  /** Accessible name of the picker and its list. */
  label: string
  /** Hover and feature-help text, or null for none. */
  help: string | null
  /** The chosen project id; "" means the "All projects" entry when `allLabel` is set. */
  value: string
  projects: ProjectPickerOption[]
  /** Label of a leading "all projects" entry with value "", or null for no such entry. */
  allLabel: string | null
  onChange: (projectId: string) => void
}

/**
 * Project picker for a science tab's top bar (ScienceTabShell `actions`): a
 * button showing the chosen project, a short divider and a chevron, that opens
 * a small list styled like the app's other menus (check mark on the chosen
 * entry). Keyboard: Enter, Space or ArrowDown opens; the arrows move; Enter or
 * Space picks; Escape, Tab or a click outside closes. The trigger carries
 * `value` (the chosen id) and the test id. The caller owns the value.
 */
export function ProjectPicker({
  testId,
  label,
  help,
  value,
  projects,
  allLabel,
  onChange,
}: ProjectPickerProps) {
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const baseId = useId()
  usePopupDismiss(open, [rootRef], () => setOpen(false))

  const entries: ProjectPickerOption[] =
    allLabel === null ? projects : [{ id: "", name: allLabel }, ...projects]
  const chosenIndex = entries.findIndex((entry) => entry.id === value)
  const optionId = (index: number) => `${baseId}-option-${index}`

  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)
      ?.scrollIntoView?.({ block: "nearest" })
  }, [open, highlight])

  const openList = () => {
    setHighlight(Math.max(chosenIndex, 0))
    setOpen(true)
  }

  const pick = (index: number) => {
    const entry = entries[index]
    setOpen(false)
    if (entry && entry.id !== value) onChange(entry.id)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
        event.preventDefault()
        openList()
      }
      return
    }
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setHighlight((current) => Math.min(current + 1, entries.length - 1))
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setHighlight((current) => Math.max(current - 1, 0))
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      pick(highlight)
    } else if (event.key === "Tab") {
      setOpen(false)
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid={testId}
        value={value}
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${baseId}-list` : undefined}
        aria-activedescendant={open ? optionId(highlight) : undefined}
        title={help ?? undefined}
        data-feature-label={label}
        data-feature-help={help ?? undefined}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        className="flex h-8 max-w-56 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-foreground text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="min-w-0 truncate">{entries[chosenIndex]?.name ?? ""}</span>
        <span aria-hidden className="h-3/5 w-px shrink-0 bg-border" />
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      {open ? (
        <div
          ref={listRef}
          id={`${baseId}-list`}
          role="listbox"
          aria-label={label}
          className="absolute top-full right-0 z-40 mt-1 flex max-h-80 w-max min-w-full max-w-72 flex-col overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground text-xs shadow-lg"
        >
          {entries.map((entry, index) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the trigger handles the keyboard through aria-activedescendant.
            <div
              key={entry.id}
              id={optionId(index)}
              data-index={index}
              role="option"
              tabIndex={-1}
              aria-selected={index === chosenIndex}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => pick(index)}
              className={cn(
                "flex h-6 w-full shrink-0 cursor-default items-center gap-1.5 rounded px-1.5 text-start text-foreground text-xs",
                index === highlight ? "bg-accent" : "",
              )}
            >
              <Check
                className={cn("size-3 shrink-0", index === chosenIndex ? "" : "invisible")}
                aria-hidden
              />
              <span className="min-w-0 truncate">{entry.name}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
