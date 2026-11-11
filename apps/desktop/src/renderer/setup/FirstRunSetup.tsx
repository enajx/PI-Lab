import type { NotificationSound } from "@pi-lab/local-db"
import { Button, cn } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, CircleAlert, CircleHelp, Loader2, RefreshCw } from "lucide-react"
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

const PLACEHOLDER_HARNESSES: HarnessStatus[] = [
  { id: "claude-code", label: "Claude Code", executable: "claude", state: "missing" },
  { id: "codex", label: "Codex", executable: "codex", state: "missing" },
]

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
  // Each row has its own check, so a fast row shows its result while a slow one
  // still says Checking….
  const harnessCheck = useQuery(trpc.setup.harnesses.queryOptions(undefined, { staleTime: 0 }))
  const githubCheck = useQuery(trpc.setup.github.queryOptions(undefined, { staleTime: 0 }))
  const zoteroCheck = useQuery(trpc.setup.zotero.queryOptions(undefined, { staleTime: 0 }))
  const checkingHarnesses = harnessCheck.isFetching
  const recheckAll = () => {
    void harnessCheck.refetch()
    void githubCheck.refetch()
    void zoteroCheck.refetch()
  }
  const settings = useQuery(trpc.settings.get.queryOptions())
  const startAtLogin = useQuery(trpc.system.startAtLogin.queryOptions())
  const appChannel = useQuery({
    queryKey: ["setup-app-channel"],
    queryFn: async () => (await window.piLab?.appIcon?.getChannel()) ?? "alpha",
  })
  const updateGeneral = useMutation(
    trpc.settings.updateGeneral.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() }),
    }),
  )
  const [, setDefaultAgent, defaultAgentError, defaultAgentPending] = useDefaultAgentId()
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
    const detected = (harnessCheck.data?.harnesses ?? []).filter(
      (harness) => harness.state === "authenticated",
    )
    if (detected.length === 1) setSelectedAgent(detected[0]?.id ?? null)
    if (detected.length !== 1) setSelectedAgent(null)
  }, [harnessCheck.data?.harnesses, selectionTouched])

  const saveApiKey = useMutation(
    trpc.setup.saveApiKey.mutationOptions({
      onSuccess: async () => {
        setApiKey("")
        setApiOpenFor(null)
        await queryClient.invalidateQueries({ queryKey: trpc.setup.harnesses.queryKey() })
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
    const saved = selectedAgent ? setDefaultAgent(selectedAgent) : Promise.resolve(true)
    void saved
      .then(async (ok) => {
        if (!ok) return
        await complete.mutateAsync({ sound: completionSound })
        await queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() })
        onClose()
      })
      .catch(() => undefined)
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
    harnessCheck.error ??
    githubCheck.error ??
    zoteroCheck.error ??
    settings.error ??
    appChannel.error ??
    updateGeneral.error ??
    startAtLogin.error ??
    setStartAtLogin.error ??
    saveApiKey.error ??
    (defaultAgentError ? new Error(defaultAgentError) : null) ??
    complete.error ??
    skip.error

  const selectClass = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"

  return (
    <div
      data-testid="first-run-setup"
      role="dialog"
      aria-modal="true"
      aria-labelledby="first-run-setup-title"
      className="fixed inset-0 z-[100] flex flex-col overflow-hidden bg-background text-foreground"
    >
      <header className="app-drag flex h-12 shrink-0 items-center border-border border-b pr-6 pl-24">
        <h1 id="first-run-setup-title" className="font-semibold text-sm">
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
          disabled={skip.isPending || setStartAtLogin.isPending || updateGeneral.isPending}
        >
          {t("Skip setup")}
        </Button>
      </header>

      <div data-testid="first-run-setup-scroll" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2.5 px-4 py-3">
          <section className="rounded-lg border border-border bg-card p-3">
            <h2 className="font-medium text-sm">{t("Appearance and notifications")}</h2>
            <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
              <label className="flex flex-col gap-1 text-xs">
                <span>{t("Language")}</span>
                <select
                  aria-label={t("Language")}
                  value={language}
                  onChange={(event) => setLanguage(event.target.value as InterfaceLanguage)}
                  className={selectClass}
                >
                  {LANGUAGES.map((item) => (
                    <option key={item.code} value={item.code}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span>{t("Theme")}</span>
                <select
                  aria-label={t("Theme mode")}
                  value={mode === "system" ? "dark" : mode}
                  onChange={(event) => setMode(event.target.value as ThemeMode)}
                  className={selectClass}
                >
                  <option value="light">{t("Light")}</option>
                  <option value="dark">{t("Dark")}</option>
                </select>
              </label>
              <div className="flex flex-col gap-1 text-xs">
                <span>{t("Completion sound")}</span>
                <div className="flex items-center gap-2">
                  <select
                    aria-label={t("Completion sound")}
                    value={completionSound}
                    onChange={(event) =>
                      setCompletionSound(event.target.value as NotificationSound)
                    }
                    className={cn(selectClass, "min-w-0 flex-1")}
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
                </div>
                <span aria-live="polite" className="min-h-4 text-[11px] text-muted-foreground">
                  {soundPreview}
                </span>
              </div>
              <div className="flex flex-col gap-1 text-xs">
                <span>{t("Start at login")}</span>
                <div className="flex items-center gap-2">
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
                  <span className="text-[11px] text-muted-foreground">
                    {startAtLogin.data?.available === false
                      ? t("Start at login is available in packaged desktop builds.")
                      : t("Launch PI Lab in the background when you sign in.")}
                  </span>
                </div>
              </div>
              {appChannel.data && appChannel.data !== "alpha" ? (
                <div className="col-span-2 flex flex-col gap-1 text-xs lg:col-span-4">
                  <label className="flex items-center gap-2">
                    <span className="shrink-0">{t("Update channel")}</span>
                    <select
                      aria-label={t("Update channel")}
                      value={settings.data?.publicUpdateChannel ?? "stable"}
                      disabled={!settings.data || updateGeneral.isPending}
                      onChange={(event) =>
                        updateGeneral.mutate({
                          publicUpdateChannel: event.target.value as "stable" | "beta",
                        })
                      }
                      className={cn(selectClass, "w-40")}
                    >
                      <option value="stable">{t("Stable")}</option>
                      <option value="beta">{t("Beta")}</option>
                    </select>
                  </label>
                  <p className="text-[11px] text-muted-foreground">
                    {t(
                      "Stable for everyday work; Beta for trying new features. Both use your projects and settings.",
                    )}{" "}
                    {t(
                      "This selects future updates. Switching to Stable will not install an older version. You can change this later in Settings.",
                    )}
                  </p>
                </div>
              ) : null}
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-3">
            <div className="mb-2 flex items-center justify-between gap-4">
              <div className="flex min-w-0 items-baseline gap-3">
                <h2 className="shrink-0 font-medium text-sm">{t("Coding agents")}</h2>
                <p className="truncate text-muted-foreground text-xs">
                  {t(
                    "Detected CLI subscriptions are ready to use. Choose a default only if you want one.",
                  )}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={recheckAll}
                disabled={
                  harnessCheck.isFetching || githubCheck.isFetching || zoteroCheck.isFetching
                }
              >
                <RefreshCw className="size-3.5" aria-hidden />
                {t("Recheck")}
              </Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {(harnessCheck.data?.harnesses ?? PLACEHOLDER_HARNESSES).map((harness) => (
                <HarnessCard
                  key={harness.id}
                  harness={harness}
                  checking={checkingHarnesses}
                  selected={selectedAgent === harness.id}
                  apiConfigured={harnessCheck.data?.apiConfigured[harness.id] ?? false}
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
                  onRetry={() => void harnessCheck.refetch()}
                />
              ))}
            </div>
            {selectedAgent === null && !checkingHarnesses ? (
              <p className="mt-2 text-muted-foreground text-xs">{t("No default selected.")}</p>
            ) : null}
          </section>

          <section className="rounded-lg border border-border bg-card p-3">
            <h2 className="font-medium text-sm">{t("Local integrations")}</h2>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <IntegrationCard
                title="GitHub"
                checking={githubCheck.isFetching}
                detail={githubCheck.data?.account ?? compactState(githubCheck.data?.state)}
                description="Clone, push, and create pull requests."
                state={githubCheck.data?.state ?? "error"}
              />
              <IntegrationCard
                title="Zotero"
                checking={zoteroCheck.isFetching}
                detail={
                  zoteroCheck.data === "running"
                    ? t("Detected")
                    : zoteroCheck.data === "installed"
                      ? t("Installed")
                      : t("Not found")
                }
                description="Use your local library as a research source."
                state={
                  zoteroCheck.data === "running"
                    ? "authenticated"
                    : zoteroCheck.data === "installed"
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

          <footer className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={skipSetup}
              disabled={skip.isPending || setStartAtLogin.isPending || updateGeneral.isPending}
            >
              {t("Skip setup")}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="first-run-setup-finish"
              onClick={finish}
              disabled={
                defaultAgentPending ||
                complete.isPending ||
                saveApiKey.isPending ||
                updateGeneral.isPending ||
                setStartAtLogin.isPending
              }
            >
              {t("Finish setup")}
            </Button>
          </footer>
        </div>
      </div>
    </div>
  )
}

function CheckingLabel() {
  const t = useTranslate()
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
      <Loader2 className="size-3 animate-spin" aria-hidden />
      {t("Checking…")}
    </span>
  )
}

function HarnessCard({
  harness,
  checking,
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
  checking: boolean
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
  const detected = !checking && harness.state === "authenticated"
  const t = useTranslate()
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2",
        selected ? "border-primary bg-primary/5" : "border-border",
      )}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          className="min-w-0 flex-1 text-start"
          onClick={detected ? onSelect : undefined}
          disabled={!detected}
        >
          <span className="flex items-center gap-2 font-medium text-sm">
            {harness.label}
            {checking ? null : <StateIcon state={harness.state} />}
            {checking ? (
              <CheckingLabel />
            ) : (
              <span
                className={cn(
                  "font-normal text-xs",
                  detected ? "text-emerald-600" : "text-muted-foreground",
                )}
              >
                {detected
                  ? t("Detected")
                  : harness.state === "missing"
                    ? t("Not detected")
                    : (harness.message ?? t("Not detected"))}
              </span>
            )}
          </span>
          {detected ? (
            <span className="mt-0.5 block text-[11px] text-muted-foreground">
              {selected ? t("Default agent") : t("Click to set as default")}
            </span>
          ) : null}
        </button>
        {apiOpen ? null : (
          <button
            type="button"
            className="shrink-0 text-[11px] text-muted-foreground underline underline-offset-4"
            onClick={onOpenApi}
          >
            {apiConfigured ? t("API key saved · replace") : t("Use API instead")}
          </button>
        )}
      </div>
      {!checking && harness.state === "error" ? (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-muted/60 p-2 text-xs">
          <p className="min-w-0 flex-1 text-muted-foreground">
            {t("Run")}{" "}
            <code className="font-mono text-foreground" dir="ltr">
              {harness.executable} login status
            </code>{" "}
            {t("in a terminal to inspect the CLI result, then try again.")}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="size-3.5" aria-hidden />
            {t("Retry detection")}
          </Button>
        </div>
      ) : null}
      {apiOpen ? (
        <div className="mt-2 flex gap-2">
          <input
            aria-label={`${harness.label} ${t("API key")}`}
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
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
      ) : null}
    </div>
  )
}

function IntegrationCard({
  title,
  detail,
  description,
  state,
  checking,
}: {
  title: string
  checking: boolean
  detail: string
  description: string
  state: HarnessStatus["state"]
}) {
  const t = useTranslate()
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="font-medium text-sm">{title}</span>
        {checking ? null : <StateIcon state={state} />}
        {checking ? (
          <span className="ms-auto">
            <CheckingLabel />
          </span>
        ) : (
          <span
            className={cn(
              "ms-auto text-xs",
              state === "authenticated" ? "text-emerald-600" : "text-muted-foreground",
            )}
          >
            {detail}
          </span>
        )}
      </div>
      <p className="mt-0.5 text-muted-foreground text-xs">{t(description)}</p>
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
