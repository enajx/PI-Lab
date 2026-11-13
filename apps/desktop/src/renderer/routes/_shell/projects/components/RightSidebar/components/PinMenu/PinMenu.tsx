import { cn } from "@pi-lab/ui"
import { useQuery } from "@tanstack/react-query"
import { Check } from "lucide-react"
import { type KeyboardEvent, useEffect, useRef, useState } from "react"
import { useTranslate } from "../../../../../../../i18n/language"
import { useTRPC } from "../../../../../../../trpc/react"

/** One row of the pin menu's tab list. `label` is already translated. */
export interface PinMenuTab {
  id: string
  label: string
  shown: boolean
  /** The last shown tab cannot be hidden. */
  disabled: boolean
}

const DEBOUNCE_MS = 120

/**
 * The right sidebar pin button's menu, drawn under the sidebar's tab strip at the
 * sidebar's width. First the sidebar's tabs, each with a check for whether it is
 * shown (clicking one shows or hides it; `tabs` is empty in views without this
 * choice), then a search for a Markdown file to pin as a tab. The search box has
 * the focus: typing searches, the arrow keys move through the tabs and the files,
 * Enter toggles the tab or pins the file there, and Escape or a click outside
 * (handled by the caller) closes it. Pinning a file closes it, toggling a tab
 * does not.
 */
export function PinMenu({
  workspaceId,
  tabs,
  onToggleTab,
  onPinFile,
}: {
  workspaceId: string
  tabs: PinMenuTab[]
  onToggleTab: (id: string) => void
  onPinFile: (relPath: string) => void
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const [query, setQuery] = useState("")
  const [debounced, setDebounced] = useState("")
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query), DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [query])

  const searching = debounced.trim().length > 0
  const search = useQuery(
    trpc.files.search.queryOptions(
      { workspaceId, query: debounced, limit: 50 },
      { staleTime: 5_000, enabled: searching },
    ),
  )
  const hits = searching
    ? (search.data?.hits ?? []).filter((hit) => hit.relPath.endsWith(".md"))
    : []
  const rowCount = tabs.length + hits.length

  // A new search highlights its first file; an empty one goes back to the first tab.
  const tabCount = tabs.length
  useEffect(() => {
    setHighlight(debounced.trim().length > 0 ? tabCount : 0)
  }, [debounced, tabCount])

  const choose = (index: number) => {
    const tab = tabs[index]
    if (tab) {
      if (!tab.disabled) onToggleTab(tab.id)
      return
    }
    const hit = hits[index - tabs.length]
    if (hit) onPinFile(hit.relPath)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setHighlight((value) => Math.min(value + 1, Math.max(rowCount - 1, 0)))
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setHighlight((value) => Math.max(value - 1, 0))
    } else if (event.key === "Enter") {
      event.preventDefault()
      choose(highlight)
    }
  }

  const rowClass = (index: number) =>
    cn(
      "flex w-full items-center gap-2 rounded px-2 py-1 text-start text-xs transition-colors",
      index === highlight ? "bg-accent text-foreground" : "text-muted-foreground",
    )

  return (
    <div
      data-testid="pin-menu"
      className="absolute inset-x-1 top-9 z-50 flex max-h-[calc(100%-2.75rem)] flex-col overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl"
    >
      {tabs.length > 0 ? (
        <div role="menu" aria-label={t("Tabs")} className="shrink-0 border-border border-b pb-1">
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={tab.shown}
              disabled={tab.disabled}
              data-testid={`pin-menu-tab-${tab.id}`}
              data-tab-id={tab.id}
              data-highlighted={index === highlight}
              data-feature-label={tab.label}
              data-feature-help={t("Show or hide this tab in the panel")}
              onClick={() => choose(index)}
              onMouseEnter={() => setHighlight(index)}
              className={cn(rowClass(index), "disabled:cursor-not-allowed disabled:opacity-60")}
            >
              <span
                className={cn(
                  "flex size-3.5 shrink-0 items-center justify-center rounded border",
                  tab.shown ? "border-primary bg-primary text-primary-foreground" : "border-border",
                )}
              >
                {tab.shown ? <Check className="size-2.5" aria-hidden /> : null}
              </span>
              <span className="min-w-0 truncate">{tab.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      <input
        ref={inputRef}
        data-testid="pin-menu-search"
        aria-label={t("Pin a Markdown panel")}
        data-feature-help={t("Search this project's Markdown files to pin one as a tab")}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          // Enter before the search runs pins a file, never toggles a tab.
          setHighlight(event.target.value.trim().length > 0 ? tabs.length : 0)
        }}
        onKeyDown={onKeyDown}
        placeholder={t("Search files by name…")}
        className="mt-1 shrink-0 rounded border border-border bg-transparent px-2 py-1 text-foreground text-xs outline-none placeholder:text-muted-foreground focus:border-primary"
      />
      {search.isError ? (
        <p role="alert" data-testid="pin-menu-error" className="px-2 py-1 text-destructive text-xs">
          {t("File search failed:")} {search.error.message}
        </p>
      ) : null}
      {search.data?.partial ? (
        <p role="status" className="px-2 py-1 text-amber-500 text-xs">
          {t("Some folders could not be searched:")} {search.data.skipped.join(", ")}
        </p>
      ) : null}
      <ul className="min-h-0 flex-1 overflow-y-auto pt-1">
        {hits.length === 0 ? (
          <li data-testid="pin-menu-empty" className="px-2 py-1 text-muted-foreground/70 text-xs">
            {searching ? t("No matching files") : t("Type to search files")}
          </li>
        ) : (
          hits.map((hit, offset) => {
            const index = tabs.length + offset
            return (
              <li key={hit.relPath}>
                <button
                  type="button"
                  data-testid="pin-menu-result"
                  data-rel-path={hit.relPath}
                  data-highlighted={index === highlight}
                  data-feature-label={hit.relPath}
                  data-feature-help={t("Pin this Markdown file as a tab")}
                  title={hit.relPath}
                  onClick={() => choose(index)}
                  onMouseEnter={() => setHighlight(index)}
                  className={rowClass(index)}
                >
                  <span className="truncate font-medium text-foreground">
                    {hit.relPath.split("/").pop()}
                  </span>
                  <span className="truncate text-muted-foreground/70">
                    {hit.relPath.includes("/")
                      ? hit.relPath.slice(0, hit.relPath.lastIndexOf("/"))
                      : ""}
                  </span>
                </button>
              </li>
            )
          })
        )}
      </ul>
    </div>
  )
}
