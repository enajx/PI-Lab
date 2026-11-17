import { type ReactNode, useEffect, useRef, useState } from "react"

/** Width of a settings panel, in px. */
const PANEL_WIDTH = 320

/**
 * A toolbar button that opens a panel below it (the Table, Chart and Aggregate
 * settings). A click outside or Escape closes it.
 */
export function SettingsPopover({
  icon,
  label,
  help,
  testId,
  active,
  iconOnly,
  children,
}: {
  icon: ReactNode
  label: string
  /** Show only the icon (the label becomes its tooltip). */
  iconOnly: boolean
  /** Hover help ("What's this?") for the button. */
  help: string
  testId: string
  /** Shown highlighted when its settings change the table. */
  active: boolean
  /** The panel's content; `close` closes the panel. */
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  // The panel opens to the left of the button, or to the right when there is no room on the left.
  const [alignLeft, setAlignLeft] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const toggle = (): void => {
    const rect = box.current?.getBoundingClientRect()
    setAlignLeft(rect !== undefined && rect.right < PANEL_WIDTH)
    setOpen((value) => !value)
  }

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener("pointerdown", onPointer)
    document.addEventListener("keydown", onKey, true)
    return () => {
      document.removeEventListener("pointerdown", onPointer)
      document.removeEventListener("keydown", onKey, true)
    }
  }, [open])

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        data-testid={testId}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-feature-label={label}
        data-feature-help={help}
        aria-label={label}
        title={iconOnly ? label : undefined}
        onClick={toggle}
        className={`flex items-center gap-1.5 rounded-md border text-xs hover:bg-accent/60 ${
          iconOnly ? "size-6 justify-center" : "px-2 py-0.5"
        } ${active ? "border-foreground/40 bg-accent/40" : "border-border"}`}
      >
        {icon}
        {iconOnly ? null : label}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={label}
          data-testid={`${testId}-panel`}
          style={{ width: PANEL_WIDTH }}
          className={`absolute top-full ${alignLeft ? "left-0" : "right-0"} z-20 mt-1 flex max-h-[70vh] flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-popover p-3 text-popover-foreground text-xs shadow-lg`}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  )
}

/** A labelled field inside a settings panel. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

/** The class of selects and inputs inside settings panels. */
export const CONTROL_CLASS =
  "min-w-0 rounded-md border border-border bg-background px-2 py-1 disabled:opacity-50"
