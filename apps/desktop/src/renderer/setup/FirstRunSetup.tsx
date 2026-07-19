import type { NotificationSound } from "@pi-lab/local-db"
import { Button, cn } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, CircleAlert, CircleHelp, RefreshCw } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { NOTIFICATION_SOUND_OPTIONS, playNotificationSound } from "../notifications/sounds"
import { useDefaultAgentId } from "../preferences/preferences"
import { type ThemeMode, useTheme } from "../providers/ThemeProvider"
import { useTRPC } from "../trpc/react"

interface FirstRunSetupProps {
  onClose: () => void
}

type HarnessStatus = {
  id: "claude-code" | "codex"
  label: string
  executable: string
  state: "missing" | "authenticated" | "unauthenticated" | "error"
  message?: string
}

/** Compact local-only setup: detected subscriptions first, opt-in encrypted API keys second. */
export function FirstRunSetup({ onClose }: FirstRunSetupProps) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const environment = useQuery(trpc.setup.environment.queryOptions())
  const settings = useQuery(trpc.settings.get.queryOptions())
  const [, setDefaultAgent] = useDefaultAgentId()
  const [selectedAgent, setSelectedAgent] = useState<"claude-code" | "codex" | null>(null)
  const [selectionTouched, setSelectionTouched] = useState(false)
  const [apiOpenFor, setApiOpenFor] = useState<"claude-code" | "codex" | null>(null)
  const [apiKey, setApiKey] = useState("")
  const [completionSound, setCompletionSound] = useState<NotificationSound>("silent")
  const [soundPreview, setSoundPreview] = useState("")
  const loadedCompletionSound = useRef(false)
  const { mode, setMode } = useTheme()

  useEffect(() => {
    if (!settings.data || loadedCompletionSound.current) return
    loadedCompletionSound.current = true
    if (settings.data.agents.setupCompleted) {
      setCompletionSound(settings.data.notifications.agentTurnCompletion.sound)
    }
  }, [settings.data])

  useEffect(() => {
    if (selectionTouched) return
    const detected = (environment.data?.harnesses ?? []).filter(
      (harness) => harness.state === "authenticated",
    )
    if (detected.length === 1) setSelectedAgent(detected[0]?.id ?? null)
    if (detected.length !== 1) setSelectedAgent(null)
  }, [environment.data?.harnesses, selectionTouched])

  const saveApiKey = useMutation(
    trpc.setup.saveApiKey.mutationOptions({
      onSuccess: async () => {
        setApiKey("")
        setApiOpenFor(null)
        await queryClient.invalidateQueries({ queryKey: trpc.setup.environment.queryKey() })
      },
    }),
  )
  const complete = useMutation(trpc.setup.complete.mutationOptions())
  const skip = useMutation(trpc.setup.skip.mutationOptions())

  const chooseAgent = (agentId: "claude-code" | "codex") => {
    setSelectionTouched(true)
    setSelectedAgent((current) => (current === agentId ? null : agentId))
  }

  const finish = () => {
    void complete.mutateAsync({ sound: completionSound }).then(
      async () => {
        if (selectedAgent) setDefaultAgent(selectedAgent)
        await queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() })
        onClose()
      },
      () => undefined,
    )
  }

  const skipSetup = () => {
    void skip.mutateAsync().then(
      async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() })
        onClose()
      },
      () => undefined,
    )
  }

  const previewSound = () => {
    setSoundPreview("Playing preview…")
    void playNotificationSound(completionSound, { suppressed: false }).then((result) => {
      if (result.status === "failed") {
        setSoundPreview(`Could not play preview: ${result.error.message}`)
        return
      }
      setSoundPreview(
        result.status === "silent" ? "Silent selected." : "Played completion preview.",
      )
    })
  }

  const error =
    environment.error ?? settings.error ?? saveApiKey.error ?? complete.error ?? skip.error

  return (
    <div
      data-testid="first-run-setup"
      role="dialog"
      aria-modal="true"
      aria-labelledby="first-run-setup-title"
      className="fixed inset-0 z-[100] flex flex-col overflow-hidden bg-background text-foreground"
    >
      <header className="app-drag flex h-14 shrink-0 items-center border-border border-b px-6">
        <h1 id="first-run-setup-title" className="font-semibold text-base">
          Set up PI Lab
        </h1>
        <span className="ml-3 text-muted-foreground text-xs">Local-only · no PI Lab account</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="app-no-drag ml-auto"
          onClick={skipSetup}
          disabled={skip.isPending}
        >
          Skip setup
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-6 py-8">
          <section className="rounded-xl border border-border bg-card p-5">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 className="font-medium text-sm">Coding agents</h2>
                <p className="mt-1 text-muted-foreground text-xs">
                  Detected CLI subscriptions are ready to use. Choose a default only if you want
                  one.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void environment.refetch()}
                disabled={environment.isFetching}
              >
                <RefreshCw className="size-3.5" aria-hidden />
                Recheck
              </Button>
            </div>
            {environment.isPending ? (
              <p className="text-muted-foreground text-sm">Checking your local environment…</p>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  {(environment.data?.harnesses ?? []).map((harness) => (
                    <HarnessCard
                      key={harness.id}
                      harness={harness}
                      selected={selectedAgent === harness.id}
                      apiConfigured={environment.data?.apiConfigured[harness.id] ?? false}
                      apiOpen={apiOpenFor === harness.id}
                      apiKey={apiOpenFor === harness.id ? apiKey : ""}
                      saving={saveApiKey.isPending}
                      onSelect={() => chooseAgent(harness.id)}
                      onOpenApi={() => {
                        setApiOpenFor(harness.id)
                        setApiKey("")
                      }}
                      onApiKeyChange={setApiKey}
                      onSaveApi={() => saveApiKey.mutate({ agentId: harness.id, apiKey })}
                      onRetry={() => void environment.refetch()}
                    />
                  ))}
                </div>
                {selectedAgent === null ? (
                  <p className="mt-3 text-muted-foreground text-xs">No default selected.</p>
                ) : null}
              </>
            )}
          </section>

          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="font-medium text-sm">Appearance and notifications</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-xs">
                <span>Theme</span>
                <select
                  aria-label="Theme mode"
                  value={mode === "system" ? "dark" : mode}
                  onChange={(event) => setMode(event.target.value as ThemeMode)}
                  className="rounded-md border border-border bg-background px-2 py-2"
                >
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-xs">
                <span>How do you want PI Lab to let you know it’s ready?</span>
                <select
                  aria-label="Completion sound"
                  value={completionSound}
                  onChange={(event) => setCompletionSound(event.target.value as NotificationSound)}
                  className="rounded-md border border-border bg-background px-2 py-2"
                >
                  {NOTIFICATION_SOUND_OPTIONS.map((sound) => (
                    <option key={sound.id} value={sound.id}>
                      {sound.label}
                    </option>
                  ))}
                </select>
                <Button type="button" variant="outline" size="sm" onClick={previewSound}>
                  Preview sound
                </Button>
                <span aria-live="polite" className="min-h-4 text-muted-foreground">
                  {soundPreview}
                </span>
              </label>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="font-medium text-sm">Local integrations</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <IntegrationCard
                title="GitHub"
                detail={
                  environment.data?.github.account ?? compactState(environment.data?.github.state)
                }
                description="Clone, push, and create pull requests."
                state={environment.data?.github.state ?? "error"}
              />
              <IntegrationCard
                title="Zotero"
                detail={
                  environment.data?.zotero === "running"
                    ? "Detected"
                    : environment.data?.zotero === "installed"
                      ? "Installed"
                      : "Not found"
                }
                description="Use your local library as a research source."
                state={
                  environment.data?.zotero === "running"
                    ? "authenticated"
                    : environment.data?.zotero === "installed"
                      ? "unauthenticated"
                      : "missing"
                }
              />
            </div>
          </section>

          {error ? (
            <p
              data-testid="first-run-setup-error"
              className="cursor-text select-text rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-xs"
            >
              {error.message}
            </p>
          ) : null}

          <footer className="flex items-center justify-end gap-2 pb-2">
            <Button type="button" variant="ghost" onClick={skipSetup} disabled={skip.isPending}>
              Skip setup
            </Button>
            <Button
              type="button"
              onClick={finish}
              disabled={complete.isPending || saveApiKey.isPending}
            >
              Finish setup
            </Button>
          </footer>
        </div>
      </div>
    </div>
  )
}

function HarnessCard({
  harness,
  selected,
  apiConfigured,
  apiOpen,
  apiKey,
  saving,
  onSelect,
  onOpenApi,
  onApiKeyChange,
  onSaveApi,
  onRetry,
}: {
  harness: HarnessStatus
  selected: boolean
  apiConfigured: boolean
  apiOpen: boolean
  apiKey: string
  saving: boolean
  onSelect: () => void
  onOpenApi: () => void
  onApiKeyChange: (value: string) => void
  onSaveApi: () => void
  onRetry: () => void
}) {
  const detected = harness.state === "authenticated"
  return (
    <div
      className={cn(
        "rounded-lg border p-4",
        selected ? "border-primary bg-primary/5" : "border-border",
      )}
    >
      <button
        type="button"
        className="w-full text-left"
        onClick={detected ? onSelect : undefined}
        disabled={!detected}
      >
        <span className="flex items-center justify-between gap-3 font-medium text-sm">
          {harness.label}
          <StateIcon state={harness.state} />
        </span>
        <span
          className={cn(
            "mt-1 block text-xs",
            detected ? "text-emerald-600" : "text-muted-foreground",
          )}
        >
          {detected
            ? "Detected"
            : harness.state === "missing"
              ? "Not detected"
              : (harness.message ?? "Not detected")}
        </span>
        {detected ? (
          <span className="mt-3 block text-muted-foreground text-[11px]">
            {selected ? "Default agent" : "Click to set as default"}
          </span>
        ) : null}
      </button>
      {harness.state === "error" ? (
        <div className="mt-3 rounded-md bg-muted/60 p-2.5 text-xs">
          <p className="text-muted-foreground">
            Run <code className="font-mono text-foreground">{harness.executable} login status</code>{" "}
            in a terminal to inspect the CLI result, then try again.
          </p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onRetry}>
            <RefreshCw className="size-3.5" aria-hidden />
            Retry detection
          </Button>
        </div>
      ) : null}
      {apiOpen ? (
        <div className="mt-3 flex gap-2">
          <input
            aria-label={`${harness.label} API key`}
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
            placeholder="API key"
          />
          <Button
            type="button"
            size="sm"
            onClick={onSaveApi}
            disabled={saving || apiKey.trim().length === 0}
          >
            Save
          </Button>
        </div>
      ) : (
        <button
          type="button"
          className="mt-3 text-muted-foreground text-[11px] underline underline-offset-4"
          onClick={onOpenApi}
        >
          {apiConfigured ? "API key saved · replace" : "Use API instead"}
        </button>
      )}
    </div>
  )
}

function IntegrationCard({
  title,
  detail,
  description,
  state,
}: {
  title: string
  detail: string
  description: string
  state: HarnessStatus["state"]
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-sm">{title}</span>
        <StateIcon state={state} />
      </div>
      <p className="mt-1 text-muted-foreground text-xs">{description}</p>
      <p className="mt-3 text-xs">
        <span className={state === "authenticated" ? "text-emerald-600" : "text-muted-foreground"}>
          {detail}
        </span>
      </p>
    </div>
  )
}

function compactState(state: HarnessStatus["state"] | undefined): string {
  if (state === "authenticated") return "Detected"
  if (state === "missing") return "Not found"
  return "Not connected"
}

function StateIcon({ state }: { state: HarnessStatus["state"] }) {
  if (state === "authenticated")
    return <CheckCircle2 className="size-4 text-emerald-600" aria-label="Detected" />
  if (state === "error")
    return <CircleAlert className="size-4 text-destructive" aria-label="Check failed" />
  return <CircleHelp className="size-4 text-muted-foreground" aria-hidden />
}
