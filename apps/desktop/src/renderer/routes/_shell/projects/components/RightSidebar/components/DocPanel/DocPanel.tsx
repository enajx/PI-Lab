import { useMutation, useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { rejectedReadMessage } from "../../../../../../../Editor/utils/rejectedRead"
import { translateKnownError } from "../../../../../../../i18n/errors"
import { useInterfaceLanguage, useTranslate } from "../../../../../../../i18n/language"
import { useTRPC } from "../../../../../../../trpc/react"
import { Markdown } from "../Markdown"

interface DocPanelProps {
  /** Workspace whose working dir the file is read from. */
  workspaceId: string
  /** File to read, relative to the workspace working dir (e.g. `RESEARCH.md`). */
  relPath: string
  /** Stable hook for E2E/component assertions (e.g. `panel-research`). */
  testId: string
  /** Heading shown when the doc is absent. */
  emptyTitle: string
  /** Supporting line under the empty heading. */
  emptyHint: ReactNode
}

/**
 * Shared panel that reads a single markdown doc from the workspace's working dir
 * via `files.read` and renders it. A missing file is the *expected* empty state, not an error: the
 * router returns `{ exists: false }`, so we show a friendly prompt rather than a
 * failure (AGENTS.md "What PI Lab is" — these are plain files the user may not have authored
 * yet).
 *
 * Scrolling follows AGENTS.md Pitfalls #3: a bounded `min-h-0 flex-1` column with a
 * native `overflow-y-auto` body — no Radix ScrollArea.
 */
export function DocPanel({ workspaceId, relPath, testId, emptyTitle, emptyHint }: DocPanelProps) {
  const t = useTranslate()
  const [language] = useInterfaceLanguage()
  const trpc = useTRPC()
  const reveal = useMutation(trpc.files.reveal.mutationOptions())
  const docQuery = useQuery(
    trpc.files.read.queryOptions(
      { workspaceId, relPath },
      // RESEARCH.md/TODO.md change out-of-band (the agent edits them), so refetch
      // on focus and keep the read fresh-ish without hammering the FS.
      { staleTime: 15_000, refetchOnWindowFocus: true },
    ),
  )

  return (
    <section data-testid={testId} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {docQuery.isPending ? (
          <p data-testid={`${testId}-loading`} className="text-muted-foreground text-sm">
            {t("Loading")} {relPath}…
          </p>
        ) : docQuery.isError ? (
          <p
            data-testid={`${testId}-error`}
            className="cursor-text select-text text-destructive text-sm"
          >
            {translateKnownError(language, docQuery.error.message)}
          </p>
        ) : docQuery.data?.status === "oversized" || docQuery.data?.status === "binary" ? (
          <div data-testid={`${testId}-rejected`} className="text-sm">
            <p>{rejectedReadMessage({ ...docQuery.data, relPath })}</p>
            <button
              type="button"
              className="underline"
              onClick={() => reveal.mutate({ workspaceId, relPath })}
            >
              {t("Reveal in Finder")}
            </button>
            {reveal.error ? (
              <p role="alert">{translateKnownError(language, reveal.error.message)}</p>
            ) : null}
          </div>
        ) : docQuery.data?.exists && docQuery.data.content.trim().length > 0 ? (
          <Markdown content={docQuery.data.content} />
        ) : (
          <div
            data-testid={`${testId}-empty`}
            className="flex flex-col gap-1 text-muted-foreground text-sm"
          >
            <p className="text-foreground/80">{emptyTitle}</p>
            <p className="text-muted-foreground/70 text-xs">{emptyHint}</p>
          </div>
        )}
      </div>
    </section>
  )
}
