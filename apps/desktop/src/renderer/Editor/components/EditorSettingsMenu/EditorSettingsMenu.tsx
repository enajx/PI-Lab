import type { EditorSettings, PythonRunDestination } from "@pi-lab/local-db/editor-settings"
import { cn } from "@pi-lab/ui"
import { Check, Settings2 } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { useTranslate } from "../../../i18n/language"
import { rememberCurrentSettingsReturnRoute } from "../../../routes/_shell/-settingsReturnRoute"
import { allEditorThemes, DEFAULT_EDITOR_THEME_ID } from "../editorThemes"

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
 * Self-contained editor-settings popover. A gear button in the editor toolbar that
 * opens a small menu toggling autosave, vim mode, Python diagnostics, and ruff
 * format-on-save. The Python type checker (`ty` ↔ `pyrefly`) lives in
 * Settings → Editor instead, so it is intentionally absent here.
 *
 * Each toggle writes just its own field through {@link onChange} so a click
 * round-trips one `settings.updateEditor` patch; the parent re-reads settings
 * reactively so the change takes effect live. Built from native elements (the
 * shared UI kit has no popover primitive) with stable `data-testid`s for tests.
 */
export function EditorSettingsMenu({ settings, onChange }: EditorSettingsMenuProps) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const labelId = useId()
  const themes = allEditorThemes(settings.customEditorThemes ?? [])
  const selectedTheme = themes.some((theme) => theme.id === settings.editorTheme)
    ? settings.editorTheme
    : DEFAULT_EDITOR_THEME_ID

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
        aria-label={t("Editor settings")}
        title={t("Editor settings")}
        data-feature-help={t(
          "Configure autosave, Vim keybindings, Python diagnostics, and format-on-save for the built-in editor",
        )}
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
          className="absolute top-9 end-0 z-50 w-60 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
        >
          <p id={labelId} className="px-2 py-1 font-medium text-muted-foreground text-xs">
            {t("Editor settings")}
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
            testId="editor-settings-diagnostics"
            label="Python diagnostics"
            description="Type-check and lint open Python files"
            checked={settings.diagnosticsEnabled}
            onToggle={() => onChange?.({ diagnosticsEnabled: !settings.diagnosticsEnabled })}
          />
          <ToggleRow
            testId="editor-settings-format-on-save"
            label="Format on save"
            description="Run ruff format on ⌘S"
            checked={settings.formatOnSave}
            onToggle={() => onChange?.({ formatOnSave: !settings.formatOnSave })}
          />
          <MenuDivider />
          <SelectRow
            testId="editor-settings-theme"
            label="Color theme"
            value={selectedTheme}
            groups={[
              {
                label: "Light",
                options: themes
                  .filter((theme) => theme.mode === "light")
                  .map((theme) => ({ value: theme.id, label: theme.label })),
              },
              {
                label: "Dark",
                options: themes
                  .filter((theme) => theme.mode === "dark")
                  .map((theme) => ({ value: theme.id, label: theme.label })),
              },
            ]}
            onChange={(editorTheme) => onChange?.({ editorTheme })}
          />
          <MenuDivider />
          <SelectRow
            testId="editor-settings-run-destination"
            label="Terminal location"
            value={settings.pythonRunDestination ?? "central"}
            options={[
              { value: "central", label: "New tab" },
              { value: "below-editor", label: "Below editor" },
            ]}
            onChange={(pythonRunDestination) =>
              onChange?.({ pythonRunDestination: pythonRunDestination as PythonRunDestination })
            }
          />
          <MenuDivider />
          <button
            type="button"
            role="menuitem"
            data-testid="editor-advanced-settings-link"
            onClick={() => {
              rememberCurrentSettingsReturnRoute()
              window.location.hash = "#/settings?section=editor&advanced=editor-typography"
            }}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs hover:bg-accent"
          >
            <span>{t("Advanced settings")}</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}

function MenuDivider() {
  return <hr className="my-1 border-0 border-border border-t" />
}

function SelectRow({
  testId,
  label,
  value,
  options,
  groups,
  onChange,
}: {
  testId: string
  label: string
  value: string
  options?: Array<{ value: string; label: string }>
  groups?: Array<{ label: string; options: Array<{ value: string; label: string }> }>
  onChange: (value: string) => void
}) {
  const t = useTranslate()
  return (
    <label className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent">
      <span>{t(label)}</span>
      <select
        data-testid={testId}
        aria-label={t(label)}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 max-w-40 rounded border border-border bg-background px-1.5 py-1 text-foreground"
      >
        {groups
          ? groups.map((group) => (
              <optgroup key={group.label} label={t(group.label)}>
                {group.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.label)}
                  </option>
                ))}
              </optgroup>
            ))
          : options?.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.label)}
              </option>
            ))}
      </select>
    </label>
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
  const t = useTranslate()
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      data-testid={testId}
      data-checked={checked}
      data-feature-label={t(label)}
      data-feature-help={t(description)}
      onClick={onToggle}
      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-start transition-colors hover:bg-accent"
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
        <span className="block text-foreground text-xs">{t(label)}</span>
        <span className="block text-muted-foreground text-[11px]">{t(description)}</span>
      </span>
    </button>
  )
}
