import { fuzzyMatch, highlightSegments } from "@pi-lab/shared/search/fuzzy"
import { cn } from "@pi-lab/ui"
import { useQuery } from "@tanstack/react-query"
import { FolderGit2 } from "lucide-react"
import type { ComponentType } from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslate } from "../i18n/language"
import { useTRPC } from "../trpc/react"

/** One row in a {@link QuickFind} list. */
export interface QuickFindItem {
  /** Stable id (React key + `data-find-id`). */
  id: string
  /** Primary, fuzzy-searched text. */
  label: string
  /** Secondary muted text shown on the right (e.g. a path). */
  hint?: string
  icon?: ComponentType<{ className?: string }>
}

interface RankedItem {
  item: QuickFindItem
  positions: number[]
}

/**
 * A generic centered quick-find overlay: a debounce-free, client-side fuzzy filter over a
 * caller-supplied list of {@link QuickFindItem}s, with match highlighting (shared
 * `@pi-lab/shared` scorer), ↑/↓ to move, Enter to pick, Esc/backdrop to dismiss. The
 * caller owns the data + the pick action — this is the reusable shell behind the
 * context-aware ⌘F (projects when outside a project, collections/folders in the Library, …).
 * Mounted only while open. Empty query lists every item in the given order.
 */
export function QuickFind({
  ariaLabel,
  placeholder,
  items,
  emptyText,
  onSelect,
  onClose,
  scopeLabel,
  allowGlobalSearch = false,
}: {
  ariaLabel: string
  placeholder: string
  items: QuickFindItem[]
  emptyText: string
  onSelect: (item: QuickFindItem) => void
  onClose: () => void
  /** Visible description of the contextual results, e.g. "Project files". */
  scopeLabel?: string
  /** Tab cycles this contextual finder to the app-wide project finder. */
  allowGlobalSearch?: boolean
}) {
  const t = useTranslate()
  const [query, setQuery] = useState("")
  const [highlight, setHighlight] = useState(0)
  const [global, setGlobal] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const trpc = useTRPC()
  const projects = useQuery(trpc.projects.list.queryOptions()).data ?? []
  const globalItems = useMemo<QuickFindItem[]>(
    () =>
      projects.map((project) => ({
        id: project.id,
        label: project.name,
        hint: project.repoPath,
        icon: FolderGit2,
      })),
    [projects],
  )
  const activeItems = global ? globalItems : items
  const activeEmptyText = global
    ? globalItems.length === 0
      ? t("No projects yet")
      : t("No matching projects")
    : emptyText
  const activeScopeLabel = global ? t("All projects") : (scopeLabel ?? ariaLabel)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const ranked = useMemo<RankedItem[]>(() => {
    const q = query.trim()
    if (!q) return activeItems.map((item) => ({ item, positions: [] }))
    return activeItems
      .map((item) => ({ item, match: fuzzyMatch(q, item.label) }))
      .filter(
        (entry): entry is { item: QuickFindItem; match: { score: number; positions: number[] } } =>
          entry.match !== null,
      )
      .sort((a, b) => b.match.score - a.match.score)
      .map((entry) => ({ item: entry.item, positions: entry.match.positions }))
  }, [query, activeItems])

  const clamped = Math.min(highlight, Math.max(ranked.length - 1, 0))

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed to the query changing
  useEffect(() => {
    setHighlight(0)
  }, [query])

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${clamped}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [clamped])

  const choose = (index: number) => {
    const entry = ranked[index]
    if (!entry) return
    onClose()
    if (global) {
      window.location.hash = `#/projects/${entry.item.id}`
    } else {
      onSelect(entry.item)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      onClose()
    } else if (event.key === "ArrowDown") {
      event.preventDefault()
      setHighlight(Math.min(clamped + 1, Math.max(ranked.length - 1, 0)))
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setHighlight(Math.max(clamped - 1, 0))
    } else if (event.key === "Enter") {
      event.preventDefault()
      choose(clamped)
    } else if (event.key === "Tab" && allowGlobalSearch) {
      event.preventDefault()
      setGlobal((value) => !value)
      setHighlight(0)
    }
  }

  return (
    <div
      data-testid="quick-find-backdrop"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
    >
      <button
        type="button"
        aria-label={t("Close quick find")}
        data-feature-help={t("Close this search without opening a result")}
        tabIndex={-1}
        onClick={onClose}
        className="-z-10 absolute inset-0 cursor-default bg-black/40"
      />
      <div
        data-testid="quick-find"
        className="flex max-h-[60vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
      >
        <input
          ref={inputRef}
          data-testid="quick-find-input"
          aria-label={ariaLabel}
          value={query}
          data-feature-help={t("Search the items available in this view")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="shrink-0 border-border border-b bg-transparent px-4 py-3 text-foreground text-sm outline-none placeholder:text-muted-foreground"
        />
        <div
          data-testid="quick-find-scope"
          className="border-border border-b px-4 py-1.5 text-muted-foreground text-xs"
        >
          {t("Searching:")} {activeScopeLabel}
          {allowGlobalSearch ? <span className="ms-2 opacity-70">{t("Tab to switch")}</span> : null}
        </div>
        <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
          {ranked.length === 0 ? (
            <li
              data-testid="quick-find-empty"
              className="px-4 py-2 text-muted-foreground/70 text-xs"
            >
              {activeEmptyText}
            </li>
          ) : (
            ranked.map((entry, index) => {
              const { item, positions } = entry
              const Icon = item.icon
              const selected = index === clamped
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    data-testid="quick-find-item"
                    data-find-id={item.id}
                    data-feature-label={item.label}
                    data-feature-help={t("Open this result in the current view")}
                    data-index={index}
                    data-highlighted={selected}
                    onClick={() => choose(index)}
                    onMouseEnter={() => setHighlight(index)}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-4 py-1.5 text-start text-xs",
                      selected
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/60",
                    )}
                  >
                    {Icon ? <Icon className="size-3.5 shrink-0 opacity-70" /> : null}
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {highlightSegments(item.label, positions).map((segment, i) => (
                        <span
                          // biome-ignore lint/suspicious/noArrayIndexKey: positional segments, stable per render
                          key={i}
                          className={segment.matched ? "font-semibold text-foreground" : undefined}
                        >
                          {segment.text}
                        </span>
                      ))}
                    </span>
                    {item.hint ? (
                      <span className="shrink-0 truncate text-muted-foreground/60">
                        {item.hint}
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })
          )}
        </ul>
      </div>
    </div>
  )
}
