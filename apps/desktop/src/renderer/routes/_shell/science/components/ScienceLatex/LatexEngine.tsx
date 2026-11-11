import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ChevronDown, Download } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { usePopupDismiss } from "../../../../../components/usePopupDismiss"
import { useTranslate } from "../../../../../i18n/language"
import { useTRPC } from "../../../../../trpc/react"

type Provider = "bundled" | "system"

/** Whether a TinyTeX installation is still running. */
function installRunning(state: string | undefined): boolean {
  return Boolean(state && !["idle", "complete", "failed"].includes(state))
}

/**
 * The LaTeX Editor footer item for the LaTeX engine. It shows the engine
 * builds use now (e.g. "TeX Live 2026" or "Tectonic"); its menu, styled like
 * the Python environment picker, sets the global engine (the same setting as
 * Settings > LaTeX). It ticks the engine builds use now (so Auto in Settings
 * shows the engine it picked): System LaTeX (disabled with a reason when not
 * installed), Bundled Tectonic, and Install TinyTeX…, which can also be used
 * when a system LaTeX is already installed.
 */
export function LatexEngineStatusItem() {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const status = useQuery(
    trpc.latex.status.queryOptions(undefined, {
      refetchInterval: (query) =>
        installRunning(query.state.data?.installation.state) ? 500 : false,
    }),
  )
  const changed = (): void => {
    void queryClient.invalidateQueries({ queryKey: trpc.latex.status.queryKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() })
  }
  const update = useMutation(trpc.settings.updateEditor.mutationOptions({ onSuccess: changed }))
  const install = useMutation(trpc.latex.install.mutationOptions({ onSuccess: changed }))
  const installState = status.data?.installation.state
  const installing = installRunning(installState)
  // An install finished: the system LaTeX and the setting may have changed.
  const finished = useRef(false)
  useEffect(() => {
    if (installState !== "complete") {
      finished.current = false
      return
    }
    if (finished.current) return
    finished.current = true
    void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() })
  }, [installState, queryClient, trpc])

  usePopupDismiss(open, [rootRef], () => setOpen(false))

  const data = status.data
  const error = status.error?.message ?? update.error?.message ?? install.error?.message ?? null
  const label = status.isPending
    ? t("Checking LaTeX…")
    : installing
      ? t("Installing TinyTeX…")
      : (data?.engine?.name ?? t("No LaTeX engine"))
  const choose = (provider: Provider): void => {
    setOpen(false)
    update.mutate({ latexProvider: provider })
  }
  const itemClass =
    "flex w-full items-start gap-2 rounded px-2 py-1.5 text-start hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
  const option = (
    provider: Provider,
    name: string,
    detail: string | null,
    disabledReason: string | null,
  ) => (
    <button
      type="button"
      role="menuitemradio"
      data-testid={`latex-engine-${provider}`}
      aria-checked={data?.engine?.kind === provider}
      disabled={disabledReason !== null}
      title={disabledReason ?? undefined}
      data-feature-label={name}
      data-feature-help={disabledReason ?? detail ?? undefined}
      onClick={() => choose(provider)}
      className={itemClass}
    >
      <span className="mt-0.5 w-3 shrink-0">
        {data?.engine?.kind === provider ? <Check className="size-3" aria-hidden /> : null}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs">{name}</span>
        {detail ? (
          <span className="block truncate text-[10px] text-muted-foreground">{detail}</span>
        ) : null}
      </span>
    </button>
  )

  return (
    <div ref={rootRef} className="relative flex min-w-0 items-center gap-2">
      {error ? (
        <span role="alert" title={error} className="min-w-0 select-text truncate text-destructive">
          {error}
        </span>
      ) : null}
      <button
        type="button"
        data-testid="latex-engine"
        title={`${t("LaTeX engine")}: ${label}`}
        data-feature-label={t("LaTeX engine")}
        data-feature-help={`${t("Current:")} ${label}. ${t("Click to choose the program that builds the PDF.")}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!data}
        onClick={() => setOpen(!open)}
        className="flex shrink-0 items-center gap-0.5 rounded px-1 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        {label}
        <ChevronDown className="size-3" aria-hidden />
      </button>
      {open && data ? (
        <div
          role="menu"
          aria-label={t("LaTeX engine")}
          className="absolute end-0 bottom-full z-30 mb-1 max-h-[min(24rem,70vh)] w-80 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <div className="px-2 py-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
            {t("LaTeX engine")}
          </div>
          {option(
            "system",
            data.system.available ? `${t("System LaTeX")}: ${data.system.name}` : t("System LaTeX"),
            data.system.available ? data.system.version : t("Not installed"),
            data.system.available ? null : (data.system.error ?? t("Not installed")),
          )}
          {option(
            "bundled",
            t("Bundled Tectonic"),
            data.bundled.available ? data.bundled.version : t("Unavailable"),
            data.bundled.available ? null : (data.bundled.error ?? t("Unavailable")),
          )}
          <div className="my-1 border-border border-t" />
          <button
            type="button"
            role="menuitem"
            data-testid="latex-engine-install"
            disabled={installing || install.isPending}
            title={t("Downloads TinyTeX, shared with VS Code and your terminal.")}
            data-feature-label={t("Install TinyTeX")}
            onClick={() => {
              setOpen(false)
              install.mutate()
            }}
            className={`${itemClass} items-center text-xs`}
          >
            <Download className="size-3 shrink-0" aria-hidden />
            {t("Install TinyTeX…")}
          </button>
          {data.installation.message ? (
            <div role="status" className="px-2 py-1 text-[10px] text-muted-foreground">
              {data.installation.message}
            </div>
          ) : null}
          {data.installation.error ? (
            <div className="mx-1 mb-1 rounded bg-destructive/10 px-2 py-1.5 text-destructive text-xs">
              {data.installation.error}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
