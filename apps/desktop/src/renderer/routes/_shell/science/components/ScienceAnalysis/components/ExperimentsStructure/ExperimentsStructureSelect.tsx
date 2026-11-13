import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import type { StructurePreset } from "../../../../../../../../main/trpc/science/analysis"
import { useTranslate } from "../../../../../../../i18n/language"
import { useTRPC } from "../../../../../../../trpc/react"

/** The presets in the order offered, with their labels (ids match the main process). */
const PRESETS: ReadonlyArray<{ id: StructurePreset; label: string }> = [
  { id: "auto", label: "Auto-detect" },
  { id: "folders", label: "Folders" },
  { id: "one-folder-per-experiment", label: "One folder per experiment" },
  { id: "experiment-run", label: "Experiment / run folders" },
  { id: "flat", label: "Flat file list" },
]

/** The select option id that is not a preset. */
const CUSTOM_OPTION = "custom"
/** The pattern offered when the user first picks a custom pattern. */
const PATTERN_PLACEHOLDER = "{experiment}/{run}/"

/** True when a stored value is one of the presets (else it is a pattern). */
function isPreset(value: string): value is StructurePreset {
  return PRESETS.some((preset) => preset.id === value)
}

/**
 * The experiments folder structure choice, read from and written to the global
 * YAML file in PI Lab's data folder through `science.analysis.getStructure` /
 * `setStructure`. With `projectId: null` it shows and sets the default
 * (Settings); with a project it shows the project's effective choice (its own
 * entry, else the default) and picking an option saves it as the project's own
 * entry. A custom pattern is typed and saved with Save. An invalid file or a refused
 * value shows the error from the main process.
 */
export function ExperimentsStructureSelect({
  projectId,
  testId,
}: {
  projectId: string | null
  testId: string
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const settings = useQuery(trpc.science.analysis.getStructure.queryOptions({ projectId }))
  const setStructure = useMutation(
    trpc.science.analysis.setStructure.mutationOptions({
      onSuccess: async () => {
        setCustomOpen(false)
        setDraft(null)
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.science.analysis.getStructure.queryKey(),
          }),
          queryClient.invalidateQueries({ queryKey: trpc.science.analysis.listFiles.queryKey() }),
        ])
      },
    }),
  )
  const [customOpen, setCustomOpen] = useState(false)
  // The pattern being typed, or null to show the saved pattern.
  const [draft, setDraft] = useState<string | null>(null)

  const data = settings.data
  // The effective value: the project's own entry, else the default.
  const stored = data
    ? projectId === null
      ? data.defaultValue
      : (data.projectValue ?? data.defaultValue)
    : null
  // Before the settings load, the select shows Auto-detect (it is disabled then).
  const selected = customOpen
    ? CUSTOM_OPTION
    : stored === null
      ? "auto"
      : isPreset(stored)
        ? stored
        : CUSTOM_OPTION
  const storedPattern = stored !== null && !isPreset(stored) ? stored : null
  // The pattern field shows whenever the custom option is selected, also for a saved pattern.
  const patternShown = selected === CUSTOM_OPTION
  const patternValue = draft ?? storedPattern ?? PATTERN_PLACEHOLDER
  const save = (value: string): void => setStructure.mutate({ projectId, value })
  const choose = (next: string): void => {
    setStructure.reset()
    setDraft(null)
    if (next === CUSTOM_OPTION) {
      setCustomOpen(true)
      return
    }
    setCustomOpen(false)
    save(next)
  }
  const error = settings.error ?? setStructure.error
  const help = data
    ? t(
        "How Analysis groups the results folder into experiments and runs. Saved in {path}.",
      ).replace("{path}", data.filePath)
    : undefined

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <select
          data-testid={testId}
          aria-label={t("Experiments folder structure")}
          data-feature-label={t("Experiments folder structure")}
          data-feature-help={help}
          title={help}
          value={selected}
          disabled={!data || setStructure.isPending}
          onChange={(event) => choose(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-foreground text-xs outline-none disabled:opacity-50"
        >
          {PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {t(preset.label)}
            </option>
          ))}
          <option value={CUSTOM_OPTION}>{t("Custom pattern")}</option>
        </select>
      </div>
      {patternShown ? (
        <form
          className="flex min-w-0 items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            save(patternValue.trim())
          }}
        >
          <input
            type="text"
            data-testid={`${testId}-pattern`}
            aria-label={t("Custom pattern")}
            value={patternValue}
            placeholder={PATTERN_PLACEHOLDER}
            onChange={(event) => setDraft(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-foreground text-xs outline-none"
          />
          <button
            type="submit"
            data-testid={`${testId}-pattern-save`}
            disabled={patternValue.trim() === "" || setStructure.isPending}
            className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("Save")}
          </button>
        </form>
      ) : null}
      {projectId === null && data ? (
        <p data-testid={`${testId}-file`} className="text-[10px] text-muted-foreground">
          {t("Saved in {path}").replace("{path}", data.filePath)}
        </p>
      ) : null}
      {error ? (
        <p
          data-testid={`${testId}-error`}
          role="alert"
          className="cursor-text select-text text-destructive text-xs"
        >
          {error.message}
        </p>
      ) : null}
    </div>
  )
}
