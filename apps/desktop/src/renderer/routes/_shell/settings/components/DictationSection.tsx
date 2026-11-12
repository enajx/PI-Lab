import { Badge, Button } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Copy, Lock, Trash2 } from "lucide-react"
import { useState } from "react"
import { LOCAL_ONLY_STATEMENT } from "../../../../dictation/DictationPill"
import { DownloadProgress } from "../../../../dictation/DownloadProgress"
import { formatBinding, useShortcutBindings } from "../../../../shortcuts/shortcuts"
import { useTRPC } from "../../../../trpc/react"
import { SelectField, SettingsSection } from "./SettingsControls"

const OUTPUT_ACTIONS = [
  { value: "insert", label: "Insert at cursor" },
  { value: "review", label: "Review first" },
  { value: "insert-copy", label: "Insert and copy" },
  { value: "copy", label: "Copy to clipboard" },
] as const

const WAVEFORM_STYLES = [
  { value: "dots", label: "Dots" },
  { value: "ascii-art", label: "ASCII" },
  { value: "lines", label: "Lines" },
] as const

const MICROPHONE_LABELS = {
  granted: "Allowed",
  denied: "Not allowed",
  "not-determined": "Not asked yet",
  restricted: "Blocked by a system policy",
} as const

/**
 * Settings > Dictation: the local-only statement, speech models (download with progress,
 * cancel, select, delete), the output action, the shortcut, microphone permission, and
 * the local dictation history.
 */
export function DictationSection() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { bindingFor } = useShortcutBindings()
  const status = useQuery(
    trpc.dictation.status.queryOptions(undefined, {
      // Poll while a download runs or the engine loads a model (after "Use"), so the
      // progress and any load error show without a reload.
      refetchInterval: (query) => {
        const data = query.state.data
        const state = data?.download.state
        const active = state === "downloading" || state === "verifying"
        return active || data?.engine.state === "loading" ? 250 : false
      },
    }),
  )
  const invalidateStatus = (): void => {
    void queryClient.invalidateQueries({ queryKey: trpc.dictation.status.queryKey() })
  }
  const download = useMutation(
    trpc.dictation.downloadModel.mutationOptions({ onSuccess: invalidateStatus }),
  )
  const cancelDownload = useMutation(
    trpc.dictation.cancelDownload.mutationOptions({ onSuccess: invalidateStatus }),
  )
  const select = useMutation(
    trpc.dictation.selectModel.mutationOptions({ onSuccess: invalidateStatus }),
  )
  const remove = useMutation(
    trpc.dictation.deleteModel.mutationOptions({ onSuccess: invalidateStatus }),
  )
  const setOutputAction = useMutation(
    trpc.dictation.setOutputAction.mutationOptions({ onSuccess: invalidateStatus }),
  )
  const setWaveformStyle = useMutation(
    trpc.dictation.setWaveformStyle.mutationOptions({ onSuccess: invalidateStatus }),
  )
  const requestMicrophone = useMutation(
    trpc.dictation.requestMicrophone.mutationOptions({ onSuccess: invalidateStatus }),
  )
  const openMicrophoneSettings = useMutation(
    trpc.dictation.openMicrophoneSettings.mutationOptions(),
  )
  const data = status.data
  const active = data?.download
  const downloading = active?.state === "downloading" || active?.state === "verifying"
  const mutationError =
    download.error ??
    cancelDownload.error ??
    select.error ??
    remove.error ??
    setOutputAction.error ??
    setWaveformStyle.error ??
    requestMicrophone.error ??
    openMicrophoneSettings.error

  return (
    <div className="flex flex-col gap-10">
      <SettingsSection
        testId="settings-section-dictation"
        title="Dictation"
        description="Speak into the focused terminal or editor."
      >
        <p className="flex gap-2 px-4 py-3 text-sm">
          <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span>{LOCAL_ONLY_STATEMENT}</span>
        </p>
        {status.isPending ? <p className="px-4 py-3 text-sm">Checking dictation…</p> : null}
        {status.error ? (
          <p role="alert" className="px-4 py-3 text-destructive text-sm">
            {status.error.message}
          </p>
        ) : null}
        {data && !data.engine.bundled ? (
          <p role="alert" className="px-4 py-3 text-destructive text-sm">
            The dictation engine is not part of this build.
          </p>
        ) : null}
        {data?.engine.error ? (
          <p role="alert" className="px-4 py-3 text-destructive text-sm">
            {data.engine.error}
          </p>
        ) : null}
        {data ? (
          <>
            <div className="flex flex-col gap-1 px-4 py-3">
              <h3 className="font-medium text-sm">Speech models</h3>
              <p className="text-muted-foreground text-xs">
                The model you need depends on how noisy your room is and how clearly you speak.
              </p>
              <ul className="mt-2 flex flex-col divide-y divide-border">
                {data.models.map((model) => {
                  const isDownloading = downloading && active?.modelKey === model.key
                  const selected = data.selectedModel === model.key
                  const percent =
                    isDownloading && active && active.totalBytes > 0
                      ? Math.round((active.receivedBytes / active.totalBytes) * 100)
                      : 0
                  return (
                    <li
                      key={model.key}
                      data-testid="dictation-model"
                      data-model-key={model.key}
                      className="flex flex-col gap-2 py-2.5"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-sm">
                          <span className="font-medium">{model.name}</span>
                          <span className="text-muted-foreground text-xs">{model.sizeLabel}</span>
                          {model.multilingual ? (
                            <Badge variant="outline">Multilingual</Badge>
                          ) : null}
                          {model.recommended ? <Badge>Recommended</Badge> : null}
                          {selected ? <Badge variant="secondary">In use</Badge> : null}
                        </div>
                        {isDownloading ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={cancelDownload.isPending}
                            onClick={() => cancelDownload.mutate()}
                          >
                            Cancel
                          </Button>
                        ) : model.installed ? (
                          <>
                            {!selected ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={select.isPending}
                                onClick={() => select.mutate({ key: model.key })}
                              >
                                Use
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              aria-label={`Delete ${model.name}`}
                              disabled={remove.isPending}
                              onClick={() => remove.mutate({ key: model.key })}
                            >
                              <Trash2 className="size-3.5" aria-hidden />
                            </Button>
                          </>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={downloading || download.isPending}
                            onClick={() => download.mutate({ key: model.key })}
                          >
                            Download
                          </Button>
                        )}
                      </div>
                      {isDownloading && active ? (
                        <div className="flex items-center gap-3 text-muted-foreground text-xs">
                          <DownloadProgress label={`${model.name} download`} percent={percent} />
                          <span className="tabular-nums">
                            {active.state === "verifying"
                              ? "Checking the file…"
                              : `${megabytes(active.receivedBytes)} of ${megabytes(active.totalBytes)} MB`}
                          </span>
                        </div>
                      ) : null}
                      {active?.modelKey === model.key && active.state === "failed" ? (
                        <p role="alert" className="text-destructive text-xs">
                          Download failed: {active.error}
                        </p>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            </div>
            <SelectField
              testId="settings-dictation-output-action"
              label="After transcription"
              description="What happens with the text."
              value={data.outputAction}
              options={[...OUTPUT_ACTIONS]}
              onChange={(value) => {
                const action = OUTPUT_ACTIONS.find((option) => option.value === value)
                if (action) setOutputAction.mutate({ action: action.value })
              }}
            />
            <SelectField
              testId="settings-dictation-waveform-style"
              label="Waveform style"
              description="How the listening pill shows your voice."
              value={data.waveformStyle}
              options={[...WAVEFORM_STYLES]}
              onChange={(value) => {
                const style = WAVEFORM_STYLES.find((option) => option.value === value)
                if (style) setWaveformStyle.mutate({ style: style.value })
              }}
            />
            <div className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
              <div className="flex flex-col">
                <span>Shortcut</span>
                <span className="text-muted-foreground text-xs">
                  Press to start. Press again, Enter or Space to stop. Esc cancels.
                </span>
              </div>
              <div className="flex items-center gap-2">
                <kbd className="min-w-12 rounded-md border border-border bg-muted px-2 py-1 text-center font-mono text-xs">
                  {formatBinding(bindingFor("dictation-toggle"))}
                </kbd>
                <Button
                  type="button"
                  size="sm"
                  variant="link"
                  onClick={() =>
                    void navigate({ to: "/settings", search: { section: "shortcuts" } })
                  }
                >
                  Change in Shortcuts
                </Button>
              </div>
            </div>
            <div className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
              <div className="flex flex-col">
                <span>Microphone</span>
                <span data-testid="dictation-microphone" className="text-muted-foreground text-xs">
                  {MICROPHONE_LABELS[data.microphone]}
                </span>
              </div>
              {data.microphone === "not-determined" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={requestMicrophone.isPending}
                  onClick={() => requestMicrophone.mutate()}
                >
                  Allow microphone
                </Button>
              ) : data.microphone !== "granted" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => openMicrophoneSettings.mutate()}
                >
                  Open System Settings
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
        {mutationError ? (
          <p role="alert" className="px-4 py-3 text-destructive text-sm">
            {mutationError.message}
          </p>
        ) : null}
      </SettingsSection>
      <DictationHistory />
    </div>
  )
}

/** How many past transcriptions the history shows before "Show all". */
const HISTORY_PREVIEW = 3

/** Past transcriptions: search, copy and delete each, or clear them all. */
function DictationHistory() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [query, setQuery] = useState("")
  const [confirmClear, setConfirmClear] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const trimmed = query.trim()
  const history = useQuery(
    trpc.dictation.history.list.queryOptions({ query: trimmed === "" ? null : trimmed }),
  )
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: trpc.dictation.history.list.queryKey() })
  }
  const remove = useMutation(
    trpc.dictation.history.delete.mutationOptions({ onSuccess: invalidate }),
  )
  const clear = useMutation(
    trpc.dictation.history.clear.mutationOptions({
      onSuccess: () => {
        setConfirmClear(false)
        invalidate()
      },
    }),
  )
  const entries = history.data ?? []
  const shown = showAll ? entries : entries.slice(0, HISTORY_PREVIEW)

  const copy = (id: string, text: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopyError(null)
        setCopied(id)
        window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 1200)
      },
      (error: unknown) =>
        setCopyError(`Could not copy: ${error instanceof Error ? error.message : String(error)}`),
    )
  }

  return (
    <SettingsSection
      testId="settings-section-dictation-history"
      title="Dictation history"
      description="The last 100 transcriptions, kept on this Mac."
    >
      <div className="flex items-center gap-2 px-4 py-3">
        <input
          type="search"
          aria-label="Search dictation history"
          placeholder="Search…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm outline-none"
        />
        {confirmClear ? (
          <>
            <span className="text-xs">Delete all dictation history?</span>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={clear.isPending}
              onClick={() => clear.mutate()}
            >
              Delete all
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={entries.length === 0 && trimmed === ""}
            onClick={() => setConfirmClear(true)}
          >
            Clear all
          </Button>
        )}
      </div>
      {history.error ? (
        <p role="alert" className="px-4 py-3 text-destructive text-sm">
          {history.error.message}
        </p>
      ) : null}
      {(remove.error ?? clear.error) ? (
        <p role="alert" className="px-4 py-3 text-destructive text-sm">
          {(remove.error ?? clear.error)?.message}
        </p>
      ) : null}
      {copyError ? (
        <p role="alert" className="px-4 py-3 text-destructive text-sm">
          {copyError}
        </p>
      ) : null}
      {history.data && entries.length === 0 ? (
        <p className="px-4 py-3 text-muted-foreground text-sm">
          {trimmed === "" ? "No dictations yet." : "No matching dictations."}
        </p>
      ) : null}
      <div
        className={
          showAll ? "max-h-80 divide-y divide-border overflow-y-auto" : "divide-y divide-border"
        }
      >
        {shown.map((entry) => (
          <div
            key={entry.id}
            data-testid="dictation-history-entry"
            className="flex items-start gap-3 px-4 py-2.5"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="select-text whitespace-pre-wrap break-words text-sm">{entry.text}</p>
              <span className="text-muted-foreground text-xs">
                {new Date(entry.createdAt).toLocaleString()}
              </span>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label="Copy"
              onClick={() => copy(entry.id, entry.text)}
            >
              {copied === entry.id ? "Copied" : <Copy className="size-3.5" aria-hidden />}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label="Delete"
              disabled={remove.isPending}
              onClick={() => remove.mutate({ id: entry.id })}
            >
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          </div>
        ))}
      </div>
      {entries.length > HISTORY_PREVIEW ? (
        <div className="px-4 py-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show fewer" : `Show all ${entries.length}`}
          </Button>
        </div>
      ) : null}
    </SettingsSection>
  )
}

function megabytes(bytes: number): string {
  return Math.round(bytes / 1_000_000).toString()
}
