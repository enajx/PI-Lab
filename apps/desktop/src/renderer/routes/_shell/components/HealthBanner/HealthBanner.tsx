import { useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useTranslate } from "../../../../i18n/language"
import { useTRPC } from "../../../../trpc/react"

/**
 * Boot/health gate (git history (build phases) P3, md/engineering/testing-and-build.md). Proves the full path — renderer →
 * TanStack Query → tRPC-React → IPC → main → SQLite — by reading `health.ping`
 * and `health.dbVersion` through the Query layer, then **gates the home content
 * on it**: until both reads resolve it shows a loading/error state; once ready it
 * mounts a small `data-testid="app-ready"` marker (the canonical E2E + smoke
 * gate) and renders its `children` (the dashboard or, under the test seam, the
 * terminal). The marker stays in the DOM and on-layout so Playwright's
 * `toBeVisible()` passes while the real surface owns the screen.
 */
export function HealthBanner({ children }: { children?: ReactNode }) {
  const t = useTranslate()
  const trpc = useTRPC()
  const ping = useQuery(trpc.health.ping.queryOptions({ message: "hello" }))
  const dbVersion = useQuery(trpc.health.dbVersion.queryOptions())

  if (ping.isError || dbVersion.isError) {
    const message = (ping.error ?? dbVersion.error)?.message ?? t("Unknown error")
    return (
      <section data-testid="app-error" className="flex flex-col gap-2 p-8">
        <h1 className="font-semibold text-xl">{t("PI Lab failed to start")}</h1>
        {/* Error text must stay selectable (AGENTS.md Pitfalls #7). */}
        <pre className="cursor-text select-text whitespace-pre-wrap text-destructive text-sm">
          {message}
        </pre>
      </section>
    )
  }

  if (ping.isPending || dbVersion.isPending) {
    return (
      <section data-testid="app-loading" className="p-8 text-muted-foreground text-sm">
        {t("Starting PI Lab…")}
      </section>
    )
  }

  const latestTag = dbVersion.data.latestTag ?? `applied:${dbVersion.data.appliedCount}`

  return (
    <div className="flex h-full flex-col">
      {/*
       * The boot marker the harness gates on. Kept tiny and screen-reader-only so
       * the dashboard owns the viewport, but present + on-layout (1px box) so
       * Playwright's toBeVisible() still passes. The health detail testids ride
       * along as element attributes for any future health probe.
       */}
      <span
        data-testid="app-ready"
        data-db-version={latestTag}
        data-db-applied-count={dbVersion.data.appliedCount}
        data-health-echo={ping.data.echo}
        className="sr-only"
      >
        {t("PI Lab ready")}
      </span>
      {children}
    </div>
  )
}
