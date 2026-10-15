import type { NotificationSound } from "@pi-lab/local-db"
import { Button, cn } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, CircleAlert, CircleHelp, RefreshCw } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import {
  type InterfaceLanguage,
  LANGUAGES,
  useInterfaceLanguage,
  useTranslate,
} from "../i18n/language"
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
  const environment = useQuery(trpc.setup.environment.queryOptions(undefined, { staleTime: 0 }))
  const settings = useQuery(trpc.settings.get.queryOptions())
  const startAtLogin = useQuery(trpc.system.startAtLogin.queryOptions())
  const [, setDefaultAgent] = useDefaultAgentId()
  const [selectedAgent, setSelectedAgent] = useState<"claude-code" | "codex" | null>(null)
  const [selectionTouched, setSelectionTouched] = useState(false)
  const [apiOpenFor, setApiOpenFor] = useState<"claude-code" | "codex" | null>(null)
  const [apiKey, setApiKey] = useState("")
  const [completionSound, setCompletionSound] = useState<NotificationSound>("silent")
  const [soundPreview, setSoundPreview] = useState("")
  const loadedCompletionSound = useRef(false)
  const { mode, setMode } = useTheme()
  const [language, setLanguage] = useInterfaceLanguage()
  const t = useTranslate()

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
  const setStartAtLogin = useMutation(
    trpc.system.setStartAtLogin.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.system.startAtLogin.queryKey() }),
    }),
  )

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
    setSoundPreview(t("Playing preview…"))
    void playNotificationSound(completionSound, { suppressed: false }).then((result) => {
      if (result.status === "failed") {
        setSoundPreview(`${t("Could not play preview:")} ${result.error.message}`)
        return
      }
      setSoundPreview(
        result.status === "silent" ? t("Silent selected.") : t("Played completion preview."),
      )
    })
  }

  const error =
    environment.error ??
    settings.error ??
    startAtLogin.error ??
    setStartAtLogin.error ??
    saveApiKey.error ??
    complete.error ??
    skip.error

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
          {t("Set up PI Lab")}
        </h1>
        <span className="ms-3 text-muted-foreground text-xs">
          {t("Local-only · no PI Lab account")}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="app-no-drag ms-auto"
          onClick={skipSetup}
          disabled={skip.isPending || setStartAtLogin.isPending}
        >
          {t("Skip setup")}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-6 py-8">
          <section className="rounded-xl border border-border bg-card p-5">
            <label className="flex flex-col gap-1.5 text-xs">
              <span>{t("Language")}</span>
              <select
                aria-label={t("Language")}
                value={language}
                onChange={(event) => setLanguage(event.target.value as InterfaceLanguage)}
                className="rounded-md border border-border bg-background px-2 py-2"
              >
                {LANGUAGES.map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </section>
          <section className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="font-medium text-sm">{t("Start at login")}</h2>
                <p className="mt-1 text-muted-foreground text-xs">
                  {t("Launch PI Lab in the background when you sign in.")}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-label={t("Start at login")}
                aria-checked={startAtLogin.data?.enabled ?? false}
                data-testid="setup-start-at-login"
                disabled={startAtLogin.data?.available === false || setStartAtLogin.isPending}
                onClick={() =>
                  setStartAtLogin.mutate({ enabled: !(startAtLogin.data?.enabled ?? false) })
                }
                className={cn(
                  "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full disabled:opacity-50",
                  startAtLogin.data?.enabled ? "bg-primary" : "bg-muted",
                )}
              >
                <span
                  className={cn(
                    "inline-block size-4 transform rounded-full bg-background shadow transition-transform",
                    startAtLogin.data?.enabled ? "translate-x-4" : "translate-x-0.5",
                  )}
                />
              </button>
            </div>
            {startAtLogin.data?.available === false ? (
              <p className="mt-2 text-muted-foreground text-xs">
                {t("Start at login is available in packaged desktop builds.")}
              </p>
            ) : null}
          </section>
          <section className="rounded-xl border border-border bg-card p-5">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 className="font-medium text-sm">{t("Coding agents")}</h2>
                <p className="mt-1 text-muted-foreground text-xs">
                  {t(
                    "Detected CLI subscriptions are ready to use. Choose a default only if you want one.",
                  )}
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
                {t("Recheck")}
              </Button>
            </div>
            {environment.isPending ? (
              <p className="text-muted-foreground text-sm">
                {t("Checking your local environment…")}
              </p>
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
                  <p className="mt-3 text-muted-foreground text-xs">{t("No default selected.")}</p>
                ) : null}
              </>
            )}
          </section>

          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="font-medium text-sm">{t("Appearance and notifications")}</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-xs">
                <span>{t("Theme")}</span>
                <select
                  aria-label={t("Theme mode")}
                  value={mode === "system" ? "dark" : mode}
                  onChange={(event) => setMode(event.target.value as ThemeMode)}
                  className="rounded-md border border-border bg-background px-2 py-2"
                >
                  <option value="light">{t("Light")}</option>
                  <option value="dark">{t("Dark")}</option>
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-xs">
                <span>{t("How do you want PI Lab to let you know it’s ready?")}</span>
                <select
                  aria-label={t("Completion sound")}
                  value={completionSound}
                  onChange={(event) => setCompletionSound(event.target.value as NotificationSound)}
                  className="rounded-md border border-border bg-background px-2 py-2"
                >
                  {NOTIFICATION_SOUND_OPTIONS.map((sound) => (
                    <option key={sound.id} value={sound.id}>
                      {t(sound.label)}
                    </option>
                  ))}
                </select>
                <Button type="button" variant="outline" size="sm" onClick={previewSound}>
                  {t("Preview sound")}
                </Button>
                <span aria-live="polite" className="min-h-4 text-muted-foreground">
                  {soundPreview}
                </span>
              </label>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="font-medium text-sm">{t("Local integrations")}</h2>
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
                    ? t("Detected")
                    : environment.data?.zotero === "installed"
                      ? t("Installed")
                      : t("Not found")
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
            <Button
              type="button"
              variant="ghost"
              onClick={skipSetup}
              disabled={skip.isPending || setStartAtLogin.isPending}
            >
              {t("Skip setup")}
            </Button>
            <Button
              type="button"
              onClick={finish}
              disabled={complete.isPending || saveApiKey.isPending || setStartAtLogin.isPending}
            >
              {t("Finish setup")}
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
  const t = useTranslate()
  return (
    <div
      className={cn(
        "rounded-lg border p-4",
        selected ? "border-primary bg-primary/5" : "border-border",
      )}
    >
      <button
        type="button"
        className="w-full text-start"
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
            ? t("Detected")
            : harness.state === "missing"
              ? t("Not detected")
              : (harness.message ?? t("Not detected"))}
        </span>
        {detected ? (
          <span className="mt-3 block text-muted-foreground text-[11px]">
            {selected ? t("Default agent") : t("Click to set as default")}
          </span>
        ) : null}
      </button>
      {harness.state === "error" ? (
        <div className="mt-3 rounded-md bg-muted/60 p-2.5 text-xs">
          <p className="text-muted-foreground">
            {t("Run")}{" "}
            <code className="font-mono text-foreground" dir="ltr">
              {harness.executable} login status
            </code>{" "}
            {t("in a terminal to inspect the CLI result, then try again.")}
          </p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onRetry}>
            <RefreshCw className="size-3.5" aria-hidden />
            {t("Retry detection")}
          </Button>
        </div>
      ) : null}
      {apiOpen ? (
        <div className="mt-3 flex gap-2">
          <input
            aria-label={`${harness.label} ${t("API key")}`}
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
            placeholder={t("API key")}
          />
          <Button
            type="button"
            size="sm"
            onClick={onSaveApi}
            disabled={saving || apiKey.trim().length === 0}
          >
            {t("Save")}
          </Button>
        </div>
      ) : (
        <button
          type="button"
          className="mt-3 text-muted-foreground text-[11px] underline underline-offset-4"
          onClick={onOpenApi}
        >
          {apiConfigured ? t("API key saved · replace") : t("Use API instead")}
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
  const t = useTranslate()
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-sm">{title}</span>
        <StateIcon state={state} />
      </div>
      <p className="mt-1 text-muted-foreground text-xs">{t(description)}</p>
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
  const t = useTranslate()
  if (state === "authenticated")
    return <CheckCircle2 className="size-4 text-emerald-600" aria-label={t("Detected")} />
  if (state === "error")
    return <CircleAlert className="size-4 text-destructive" aria-label={t("Check failed")} />
  return <CircleHelp className="size-4 text-muted-foreground" aria-hidden />
}
