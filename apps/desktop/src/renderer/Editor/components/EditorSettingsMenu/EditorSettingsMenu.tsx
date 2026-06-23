import type { EditorSettings } from "@skipper/local-db"
import { cn } from "@skipper/ui"
import { Check, Settings2 } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"

interface EditorSettingsMenuProps {
  /** Current editor preferences (drives the toggle states). */
  settings: EditorSettings
  /**
   * Persist a single-field patch (wired to `settings.updateEditor`). When
   * omitted the toggles render but do nothing — the parent supplies this in the
   * app; tests can omit it to assert the read-only shape.
   */
  onChange?: (patch: Partial<EditorSettings>) => void
}

/**
 * Self-contained editor-settings popover (AGENTS.md §7; spec: TODO "Built-in
 * editor" — "Editor settings group"). A gear button in the editor toolbar that
 * opens a small menu toggling the four v1 preferences: autosave, vim mode, the
 * Python type checker (`ty` ↔ `pyrefly`), and ruff format-on-save. There is no
 * global settings page yet, so this lives next to the buffer it configures.
 *
 * Each toggle writes just its own field through {@link onChange} so a click
 * round-trips one `settings.updateEditor` patch; the parent re-reads settings
 * reactively so the change takes effect live. Built from native elements (the
 * shared UI kit has no popover primitive) with stable `data-testid`s for tests.
 */
export function EditorSettingsMenu({ settings, onChange }: EditorSettingsMenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const labelId = useId()

  // Close on outside click or Escape so the menu behaves like a real popover.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    window.addEventListener("mousedown", onPointerDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("mousedown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="editor-settings"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Editor settings"
        title="Editor settings"
        onClick={() => setOpen((value) => !value)}
        className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Settings2 className="size-4" aria-hidden />
      </button>

      {open ? (
        <div
          data-testid="editor-settings-menu"
          role="menu"
          aria-labelledby={labelId}
          className="absolute top-9 right-0 z-50 w-60 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
        >
          <p id={labelId} className="px-2 py-1 font-medium text-muted-foreground text-xs">
            Editor settings
          </p>

          <ToggleRow
            testId="editor-settings-autosave"
            label="Autosave"
            description="Save on a short delay instead of ⌘S"
            checked={settings.autosave}
            onToggle={() => onChange?.({ autosave: !settings.autosave })}
          />
          <ToggleRow
            testId="editor-settings-vim"
            label="Vim mode"
            description="CodeMirror Vim keymap"
            checked={settings.vim}
            onToggle={() => onChange?.({ vim: !settings.vim })}
          />
          <ToggleRow
            testId="editor-settings-format-on-save"
            label="Format on save"
            description="Run ruff format on ⌘S"
            checked={settings.formatOnSave}
            onToggle={() => onChange?.({ formatOnSave: !settings.formatOnSave })}
          />

          <div className="my-1 border-border/60 border-t" />

          <p className="px-2 py-1 text-muted-foreground text-xs">Type checker</p>
          <div className="flex gap-1 px-1 pb-1">
            <CheckerOption
              testId="editor-settings-checker-ty"
              label="ty"
              active={settings.typeChecker === "ty"}
              onSelect={() => onChange?.({ typeChecker: "ty" })}
            />
            <CheckerOption
              testId="editor-settings-checker-pyrefly"
              label="pyrefly"
              active={settings.typeChecker === "pyrefly"}
              onSelect={() => onChange?.({ typeChecker: "pyrefly" })}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}

interface ToggleRowProps {
  testId: string
  label: string
  description: string
  checked: boolean
  onToggle: () => void
}

/** A single on/off preference row with a checkbox-style affordance. */
function ToggleRow({ testId, label, description, checked, onToggle }: ToggleRowProps) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      data-testid={testId}
      data-checked={checked}
      onClick={onToggle}
      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
          checked ? "border-primary bg-primary text-primary-foreground" : "border-border",
        )}
      >
        {checked ? <Check className="size-3" aria-hidden /> : null}
      </span>
      <span className="min-w-0">
        <span className="block text-foreground text-xs">{label}</span>
        <span className="block text-muted-foreground text-[11px]">{description}</span>
      </span>
    </button>
  )
}

interface CheckerOptionProps {
  testId: string
  label: string
  active: boolean
  onSelect: () => void
}

/** A segmented-control style choice for the active type checker. */
function CheckerOption({ testId, label, active, onSelect }: CheckerOptionProps) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      data-testid={testId}
      data-active={active}
      onClick={onSelect}
      className={cn(
        "flex-1 rounded-md px-2 py-1 text-center font-medium text-xs transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {label}
    </button>
  )
}
