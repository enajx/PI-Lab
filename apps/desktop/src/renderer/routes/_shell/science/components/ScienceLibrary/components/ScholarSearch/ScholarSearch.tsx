import { Button, Input } from "@skipper/ui"
import { useQuery } from "@tanstack/react-query"
import { Search } from "lucide-react"
import { useState } from "react"
import { useTRPC } from "../../../../../../../trpc/react"
import { LibraryItem } from "../LibraryItem"

/**
 * Semantic Scholar search panel for the Library tab (AGENTS.md §1) — a query box
 * over `science.library.searchPapers`. The query only runs once the user submits
 * a non-empty term (no key required; the router keeps the field set + page size
 * small to stay polite). Results reuse the shared {@link LibraryItem} card with a
 * `scholar-result` test id; empty/error states are rendered inline. Paper
 * *recommendations* are deferred to v2.
 */
export function ScholarSearch() {
  const trpc = useTRPC()
  const [draft, setDraft] = useState("")
  const [submitted, setSubmitted] = useState("")

  const search = useQuery({
    ...trpc.science.library.searchPapers.queryOptions({ query: submitted }),
    enabled: submitted.length > 0,
    staleTime: 60_000,
  })

  const submit = () => {
    const trimmed = draft.trim()
    if (trimmed.length === 0) return
    setSubmitted(trimmed)
  }

  const result = search.data
  const papers = result?.ok ? result.papers : []

  return (
    <section data-testid="scholar-search" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
          <Input
            data-testid="scholar-search-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                submit()
              }
            }}
            placeholder="Search papers on Semantic Scholar…"
            className="h-9 pl-8"
          />
        </div>
        <Button
          type="button"
          size="sm"
          data-testid="scholar-search-submit"
          disabled={draft.trim().length === 0 || search.isFetching}
          onClick={submit}
        >
          {search.isFetching ? "Searching…" : "Search"}
        </Button>
      </div>

      {submitted.length === 0 ? (
        <p data-testid="scholar-search-idle" className="text-muted-foreground text-xs">
          Look up papers by title, keywords, or author. No Zotero connection required.
        </p>
      ) : search.isLoading ? (
        <p className="text-muted-foreground text-xs">Searching…</p>
      ) : result && !result.ok ? (
        <p
          data-testid="scholar-search-error"
          className="cursor-text select-text text-destructive text-xs"
        >
          {result.message}
        </p>
      ) : papers.length === 0 ? (
        <p data-testid="scholar-search-empty" className="text-muted-foreground text-xs">
          No papers found for “{submitted}”.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {papers.map((paper) => (
            <LibraryItem key={paper.id} paper={paper} testId="scholar-result" />
          ))}
        </div>
      )}
    </section>
  )
}
