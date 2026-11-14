import { fuzzyMatch } from "@pi-lab/shared/search/fuzzy"
import { Button } from "@pi-lab/ui"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronRight, FileText, Folder, RefreshCw } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type {
  LibraryCollection,
  LibraryPaper,
} from "../../../../../../../../main/trpc/science/library"
import { useTranslate } from "../../../../../../../i18n/language"
import { QuickFind, type QuickFindItem } from "../../../../../../../QuickFind"
import { overlayIsOpen } from "../../../../../../../shortcuts/keyGuards"
import { eventMatchesShortcut } from "../../../../../../../shortcuts/shortcuts"
import { useTRPC } from "../../../../../../../trpc/react"
import type { ViewerTab } from "../../libraryTabs"
import { AttachFileFlow } from "../AttachFileFlow"
import { CollectionRow } from "../CollectionRow"
import { LibraryItem } from "../LibraryItem"
import { OpenItemButton } from "../OpenItemButton"

interface LibraryBrowserProps {
  /** Source kind — picks the per-item action (folder "Open" vs Zotero "Attach"). */
  kind: "zotero" | "folder"
  /** Whether the source can write — gates the Zotero per-item "Attach" action. */
  canWrite: boolean
  /** Root-breadcrumb label (the folder name for a folder source, else "Zotero library"). */
  rootLabel: string
  /** Open a viewer tab on the right (a paper's local file, or its URL when none is on disk). */
  onOpenTab: (tab: ViewerTab) => void
}

interface Crumb {
  key: string
  name: string
}

/** A navigable row in the current view, in display order — the keyboard cursor walks these. */
type Row =
  | { type: "all-items" }
  | { type: "collection"; key: string; name: string }
  | { type: "deep"; parent: LibraryCollection; child: LibraryCollection }
  | { type: "paper"; id: string }

/**
 * The connected-source view: a **collections browser** shared by Zotero and the local
 * folder source. The default (root) shows the top-level collections plus an "All items"
 * entry; drilling into a collection shows its subcollections and items, with a breadcrumb
 * back up. Items reuse {@link LibraryItem} (with the folder "Open" or Zotero "Attach"
 * action); collections use {@link CollectionRow}. Reads go through `listCollections`/
 * `listItems`, which are source-agnostic.
 *
 * Keyboard navigation lives on a `window` listener, so it works regardless of focus and never
 * scrolls the page (the pane stays focusable for click-to-focus). `↓`/`↑` move the row cursor;
 * `⌘→` and `⌘↓` activate the selected row — entering a collection (or "All items"), or opening
 * a paper; `⌘←`/`⌘↑` go back one level. `⌃` works as an alias for `⌘`. `Enter` is a universal
 * **activate**: it drills into a selected collection / "All items" row (like `⌘→`), or opens a
 * selected paper's local file in a viewer tab (`onOpenTab`); clicking a paper card does the same.
 * When a Zotero item has no file on disk, the "no local copy" message shows and its URL (if any)
 * opens in a tab. `⌘↵` opens the paper's local copy in the OS default app instead — a folder PDF
 * via `openItem`, a Zotero item's attachment via `openZoteroItem`.
 *
 * Typing a character fuzzy-filters this level's rows (the same matcher as `⌘F`), Backspace edits
 * the text, and Escape clears it, or goes up one level when nothing is typed. Keys are ignored
 * while an overlay is open or focus is in a text field or the viewer pane (`data-library-viewer`).
 */
export function LibraryBrowser({ kind, canWrite, rootLabel, onOpenTab }: LibraryBrowserProps) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [trail, setTrail] = useState<Crumb[]>([])
  const [viewAll, setViewAll] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  // Text typed to filter this level's rows; cleared on every level change.
  const [query, setQuery] = useState("")
  // The context-aware ⌘F finder over this level's collections, their immediate sub-collections
  // (one level deeper), and papers once they show at this level — see `finderEntries` below.
  const [findOpen, setFindOpen] = useState(false)
  // Surfaced when an "open externally" gesture (Enter / ⌘↵, or ⌘→/⌘↓ on a folder paper) can't
  // open the item — e.g. the file is gone, or a Zotero item has no local copy on disk.
  const [openError, setOpenError] = useState<string | null>(null)
  // A plain (not error) note, e.g. an item with no local copy and no web address.
  const [openNote, setOpenNote] = useState<string | null>(null)
  const paneRef = useRef<HTMLElement>(null)
  const current = trail.length > 0 ? trail[trail.length - 1] : null

  // Collections at this level: top-level at root, else the current collection's children.
  const collectionsQuery = useQuery({
    ...trpc.science.library.listCollections.queryOptions(current ? { parentKey: current.key } : {}),
    enabled: !viewAll,
    staleTime: 30_000,
  })
  // Keyboard "open" for folder items (the per-item Open button has its own mutation).
  const openItem = useMutation(trpc.science.library.openItem.mutationOptions())
  // "Open local copy" for Zotero items — resolves the item's best attachment to an on-disk file.
  const openZoteroItem = useMutation(trpc.science.library.openZoteroItem.mutationOptions())
  // Items: the whole library in "All items", a collection's items when drilled in, none at root.
  const showItems = viewAll || current != null
  const itemsQuery = useQuery({
    ...trpc.science.library.listItems.queryOptions(current ? { collectionKey: current.key } : {}),
    enabled: showItems,
    staleTime: 30_000,
  })

  const collections: LibraryCollection[] = collectionsQuery.data?.ok
    ? collectionsQuery.data.collections
    : []
  const items: LibraryPaper[] = itemsQuery.data?.ok ? itemsQuery.data.items : []
  const truncated = itemsQuery.data?.ok ? (itemsQuery.data.truncated ?? false) : false
  const errorOf = (q: typeof collectionsQuery | typeof itemsQuery) =>
    q.data && !q.data.ok && q.data.reason === "error" ? q.data.message : null
  const error = errorOf(collectionsQuery) ?? errorOf(itemsQuery) ?? null
  const isFetching =
    (!viewAll && collectionsQuery.isFetching) || (showItems && itemsQuery.isFetching)

  // Children of each current-level collection — one query per collection, aligned positionally
  // with `collections` — so the ⌘F finder can offer sub-collections one level deeper and drill
  // straight into them. Eager + 30s-cached so the finder opens without waiting on a fetch.
  const childQueries = useQueries({
    queries: collections.map((c) => ({
      ...trpc.science.library.listCollections.queryOptions({ parentKey: c.key }),
      staleTime: 30_000,
    })),
  })
  // Flatten the OK results into parent→child pairs (skip pending/errored queries).
  const subCollections: { parent: LibraryCollection; child: LibraryCollection }[] =
    collections.flatMap((parent, i) => {
      const data = childQueries[i]?.data
      return data?.ok ? data.collections.map((child) => ({ parent, child })) : []
    })

  // This level's rows that match the typed text, best match first.
  const visibleCollections = filterByQuery(collections, (c) => c.name, query)
  const visibleItems = filterByQuery(items, (p) => p.title, query)
  const showAllItemsRow = fuzzyMatch(query, t("All items")) !== null
  // Typing also finds sub-collections one level down, like the ⌘F finder.
  const visibleDeep =
    query && !viewAll ? filterByQuery(subCollections, ({ child }) => child.name, query) : []
  const deepRows: Row[] = visibleDeep.map(({ parent, child }) => ({ type: "deep", parent, child }))

  // The navigable rows for this view, in render order (root: All items + collections;
  // drilled: collections + items; All items: items). The cursor index points into this.
  const rows: Row[] = (() => {
    const collectionRows: Row[] =
      !viewAll && current == null
        ? [
            ...(showAllItemsRow ? [{ type: "all-items" } as Row] : []),
            ...visibleCollections.map((c) => collectionToRow(c)),
            ...deepRows,
          ]
        : !viewAll
          ? [...visibleCollections.map((c) => collectionToRow(c)), ...deepRows]
          : []
    const paperRows: Row[] = showItems
      ? visibleItems.map((p) => ({ type: "paper", id: p.id }) as Row)
      : []
    return [...collectionRows, ...paperRows]
  })()
  // Clamp the raw cursor for reading (rows can shrink on refresh between view resets).
  const cursor = rows.length > 0 ? Math.min(Math.max(selectedIndex, 0), rows.length - 1) : 0
  const selectedRow: Row | undefined = rows[cursor]

  const openCollection = (c: Crumb) => {
    setViewAll(false)
    setTrail((t) => [...t, c])
  }
  // Open a sub-collection one level down (parent, then child), as a ⌘F pick does.
  const openDeep = (parent: LibraryCollection, child: LibraryCollection) => {
    setViewAll(false)
    setTrail((t) => [
      ...t,
      { key: parent.key, name: parent.name },
      { key: child.key, name: child.name },
    ])
  }
  const openAll = () => {
    setTrail([])
    setViewAll(true)
  }
  const goToRoot = () => {
    setViewAll(false)
    setTrail([])
  }
  const goToCrumb = (index: number) => {
    setViewAll(false)
    setTrail((t) => t.slice(0, index + 1))
  }
  // Up one level: All items → root; otherwise pop the last breadcrumb (depth 1 → root).
  const goBack = () => {
    if (viewAll) goToRoot()
    else if (trail.length > 0) goToCrumb(trail.length - 2)
  }
  // Open the selected paper's local copy in the OS default app. Folder papers resolve to an
  // on-disk file via the traversal-guarded `openItem`; Zotero papers resolve their best file
  // attachment via `openZoteroItem` (which reports "no local copy" rather than failing silently
  // when nothing is on disk). Bound to Enter / ⌘↵ (and ⌘→/⌘↓ for folder papers). Errors surface
  // inline as selectable text.
  const openSelectedItem = async () => {
    if (selectedRow?.type !== "paper") return
    setOpenError(null)
    try {
      const result =
        kind === "folder"
          ? await openItem.mutateAsync({ path: selectedRow.id })
          : await openZoteroItem.mutateAsync({ itemKey: selectedRow.id })
      if (!result.ok) setOpenError(result.message ?? t("Couldn't open the file."))
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : t("Open failed."))
    }
  }
  // Open a paper in a viewer tab: its local file, or — when a Zotero item has nothing on disk —
  // the "no local copy" message plus its URL in a tab. Other failures show inline.
  const openInViewer = async (paper: LibraryPaper) => {
    setOpenError(null)
    setOpenNote(null)
    const result = await queryClient.fetchQuery(
      trpc.science.library.resolveFile.queryOptions({ itemId: paper.id }),
    )
    if (result.ok) {
      onOpenTab({ type: "file", id: `file:${paper.id}`, itemId: paper.id, title: paper.title })
      return
    }
    // No local copy: the item's web page opens in a tab instead (no error line); with no web
    // address either, a plain note says so.
    if (result.reason === "no-local-file") {
      if (paper.url) {
        onOpenTab({ type: "url", id: `url:${paper.url}`, url: paper.url, title: paper.title })
      } else {
        setOpenNote(t("This item has no local copy and no web address."))
      }
      return
    }
    setOpenError(result.message)
  }
  const openPaperRow = (id: string) => {
    const paper = items.find((p) => p.id === id)
    if (paper) void openInViewer(paper)
  }
  // Enter / ⌘→ / ⌘↓ activate: drill into a selected collection / "All items" row, or open a
  // selected paper in a viewer tab.
  const activateSelected = () => {
    const row = rows[cursor]
    if (row?.type === "all-items") openAll()
    else if (row?.type === "collection") openCollection({ key: row.key, name: row.name })
    else if (row?.type === "deep") openDeep(row.parent, row.child)
    else if (row?.type === "paper") openPaperRow(row.id)
  }
  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: trpc.science.library.listCollections.queryKey(),
    })
    void queryClient.invalidateQueries({ queryKey: trpc.science.library.listItems.queryKey() })
  }

  const onKeyDown = (event: KeyboardEvent) => {
    // The finder and other overlays own the keyboard while open, and we never hijack typing
    // inside form fields or the viewer pane. A key another handler already took (Escape or
    // Enter in the ⌘F finder, which closes before this window listener runs) is ignored too.
    if (event.defaultPrevented || findOpen || overlayIsOpen()) return
    const active = document.activeElement
    if (
      active instanceof HTMLElement &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.isContentEditable ||
        active.closest("[data-library-viewer]"))
    )
      return
    const mod = event.metaKey || event.ctrlKey
    // Type-to-filter: a printable character adds to the text; Backspace removes one.
    if (event.key.length === 1 && !mod && !(event.key === " " && !query)) {
      event.preventDefault()
      setQuery((q) => q + event.key)
      return
    }
    switch (event.key) {
      case "Backspace":
        if (!query) return
        event.preventDefault()
        setQuery((q) => q.slice(0, -1))
        return
      case "Escape":
        // Clear the typed text first; with none, go up one level (nothing at the root).
        if (query) setQuery("")
        else if (viewAll || trail.length > 0) goBack()
        else return
        event.preventDefault()
        return
      case "ArrowDown":
        event.preventDefault()
        if (mod) {
          activateSelected() // ⌘↓ activates the row, same as ⌘→
          return
        }
        setSelectedIndex((i) => Math.min(i + 1, Math.max(rows.length - 1, 0)))
        return
      case "ArrowUp":
        event.preventDefault()
        if (mod)
          goBack() // ⌘↑ goes back
        else setSelectedIndex((i) => Math.max(i - 1, 0))
        return
      case "ArrowLeft":
        if (mod) {
          event.preventDefault()
          goBack()
        }
        return
      case "ArrowRight":
        if (mod) {
          event.preventDefault()
          activateSelected()
        }
        return
      case "Enter":
        // Enter activates the row (a paper opens in a viewer tab); ⌘↵ on a paper opens it in the
        // OS default app. We only bail for text fields (handled above) — NOT for focused buttons:
        // arrow-nav moves the cursor without changing DOM focus, so after clicking any control
        // (Open, Refresh) focus lingers there; gating on button focus would swallow Enter.
        if (!selectedRow) return
        event.preventDefault()
        if (mod && selectedRow.type === "paper") void openSelectedItem()
        else activateSelected()
        return
    }
  }
  // Latest handler in a ref so the (mount-once) native listener always calls current logic.
  const onKeyDownRef = useRef(onKeyDown)
  onKeyDownRef.current = onKeyDown

  // Keep the pane focusable for click-to-focus (set imperatively to dodge the a11y lint that
  // fires on a tabIndex'd non-interactive <section>). The arrow nav lives on `window` below, so
  // it no longer depends on which element holds focus.
  useEffect(() => {
    if (paneRef.current) paneRef.current.tabIndex = 0
  }, [])

  // Level/path arrow nav on `window` (mount-once) so ⌘/⌃-arrows work regardless of focus and
  // never scroll the page. The handler reads fresh state through `onKeyDownRef` (refreshed every
  // render — mirrors the shell's ⌘F `pathRef`), so we never re-subscribe per keystroke.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => onKeyDownRef.current(event)
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])

  // Context-aware ⌘F: while the connected library is open, the quick-open shortcut opens the
  // collection finder (the shell skips /science/library so this is the sole ⌘F owner here).
  // Mounted only in this connected/browser view — the source-chooser has no finder. The
  // pane nav above stays intact: this listener only *opens* the finder, which then owns keys.
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (eventMatchesShortcut(event, "quick-open")) {
        event.preventDefault()
        setFindOpen(true)
      }
    }
    window.addEventListener("keydown", onWindowKeyDown)
    return () => window.removeEventListener("keydown", onWindowKeyDown)
  }, [])

  // Reset the cursor to the top of each new view (entering/leaving a collection, by key or
  // click). Nav now lives on `window`, so no refocus is needed to keep the keyboard working.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trail/viewAll define the view.
  useEffect(() => {
    setSelectedIndex(0)
    setOpenError(null)
    setOpenNote(null)
    setQuery("")
  }, [trail, viewAll])
  // Each change to the typed text puts the cursor on the best match.
  // biome-ignore lint/correctness/useExhaustiveDependencies: query is the intended trigger.
  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Keep the highlighted row in view as the cursor moves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cursor is the intended trigger.
  useEffect(() => {
    paneRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest" })
  }, [cursor])

  const collectionRow = (c: LibraryCollection) => (
    <CollectionRow
      key={c.key}
      name={c.name}
      itemCount={c.itemCount}
      selected={selectedRow?.type === "collection" && selectedRow.key === c.key}
      onClick={() => openCollection({ key: c.key, name: c.name })}
    />
  )

  const deepRow = ({ parent, child }: { parent: LibraryCollection; child: LibraryCollection }) => (
    <CollectionRow
      key={`deep:${child.key}`}
      name={child.name}
      hint={parent.name}
      itemCount={child.itemCount}
      selected={selectedRow?.type === "deep" && selectedRow.child.key === child.key}
      onClick={() => openDeep(parent, child)}
    />
  )

  // The ⌘F finder's rows, in display order: this level's collections, then their immediate
  // sub-collections (a `deep:` pick drills two levels at once), then papers once they show at
  // this level. A `run` per row keeps onSelect uniform across the three id kinds.
  const finderEntries: { item: QuickFindItem; run: () => void }[] = [
    ...collections.map((c) => ({
      item: { id: `coll:${c.key}`, label: c.name, icon: Folder },
      run: () => openCollection({ key: c.key, name: c.name }),
    })),
    ...subCollections.map(({ parent, child }) => ({
      item: { id: `deep:${child.key}`, label: child.name, hint: parent.name, icon: Folder },
      run: () => openDeep(parent, child),
    })),
    ...(showItems
      ? items.map((p) => ({
          item: {
            id: `paper:${p.id}`,
            label: p.title,
            hint: p.authors.length > 0 ? p.authors.join(", ") : undefined,
            icon: FileText,
          },
          // A picked paper opens in a viewer tab, like Enter.
          run: () => void openInViewer(p),
        }))
      : []),
  ]

  return (
    <section
      ref={paneRef}
      data-testid="library-browser"
      className="flex flex-col gap-3 focus:outline-none"
    >
      <div className="flex items-center justify-between gap-2">
        <nav
          data-testid="library-breadcrumb"
          className="flex min-w-0 flex-wrap items-center gap-1 text-muted-foreground text-xs"
        >
          <button
            type="button"
            data-testid="library-crumb-root"
            data-feature-label={rootLabel}
            data-feature-help={t("Return to the top level of the connected research library.")}
            onClick={goToRoot}
            className="max-w-[12rem] truncate font-medium text-[10px] uppercase tracking-wider hover:text-foreground"
          >
            {rootLabel}
          </button>
          {trail.map((c, index) => (
            <span key={c.key} className="flex items-center gap-1">
              <ChevronRight className="size-3" aria-hidden />
              <button
                type="button"
                data-feature-label={c.name}
                data-feature-help={t("Return to this collection in the library path.")}
                onClick={() => goToCrumb(index)}
                className="max-w-[12rem] truncate hover:text-foreground"
              >
                {c.name}
              </button>
            </span>
          ))}
          {viewAll ? (
            <span className="flex items-center gap-1">
              <ChevronRight className="size-3" aria-hidden />
              <span className="text-foreground">{t("All items")}</span>
            </span>
          ) : null}
        </nav>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="library-refresh"
          data-feature-label={t("Refresh library")}
          data-feature-help={t("Reload collections and papers from the connected library source.")}
          className="h-7 shrink-0 gap-1.5 text-muted-foreground text-xs"
          disabled={isFetching}
          onClick={refresh}
        >
          <RefreshCw className="size-3.5" />
          {isFetching ? t("Refreshing…") : t("Refresh")}
        </Button>
      </div>

      {/* The hint, replaced by the typed text while the user types. */}
      <div className="text-xs">
        {query ? (
          <p data-testid="library-type-query" className="truncate font-mono text-foreground">
            {">"} {query}
          </p>
        ) : (
          <p data-testid="library-type-hint" className="text-muted-foreground">
            {kind === "zotero"
              ? t("Zotero Library: type to navigate library")
              : `${rootLabel}: ${t("type to navigate library")}`}
          </p>
        )}
      </div>

      {error ? (
        <p data-testid="library-error" className="cursor-text select-text text-destructive text-xs">
          {error}
        </p>
      ) : null}

      {openError ? (
        <p
          data-testid="library-open-error"
          className="cursor-text select-text text-destructive text-xs"
        >
          {openError}
        </p>
      ) : null}

      {openNote ? (
        <p data-testid="library-open-note" className="text-muted-foreground text-xs">
          {openNote}
        </p>
      ) : null}

      {!viewAll && !current ? (
        <div className="flex flex-col gap-2">
          {showAllItemsRow ? (
            <CollectionRow
              name={t("All items")}
              testId="library-all-items"
              selected={selectedRow?.type === "all-items"}
              onClick={openAll}
            />
          ) : null}
          {collectionsQuery.isLoading ? (
            <p className="text-muted-foreground text-xs">{t("Loading collections…")}</p>
          ) : (
            visibleCollections.map(collectionRow)
          )}
          {visibleDeep.map(deepRow)}
          {!collectionsQuery.isLoading && collections.length === 0 && !error ? (
            <p data-testid="library-collections-empty" className="text-muted-foreground text-xs">
              {t("No collections — open “All items” to browse everything.")}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {!viewAll ? visibleCollections.map(collectionRow) : null}
          {visibleDeep.map(deepRow)}
          {itemsQuery.isLoading ? (
            <p className="text-muted-foreground text-xs">{t("Loading items…")}</p>
          ) : (
            visibleItems.map((paper) => (
              <LibraryItem
                key={paper.id}
                paper={paper}
                testId="library-item"
                onOpen={() => void openInViewer(paper)}
                selected={selectedRow?.type === "paper" && selectedRow.id === paper.id}
                action={
                  kind === "folder" ? (
                    <OpenItemButton path={paper.id} />
                  ) : canWrite ? (
                    <AttachFileFlow itemKey={paper.id} />
                  ) : undefined
                }
              />
            ))
          )}
          {truncated ? (
            <p data-testid="library-truncated" className="text-muted-foreground text-xs">
              {t("Showing the first")} {items.length}{" "}
              {t("items — open a subfolder to narrow the list.")}
            </p>
          ) : null}
          {!itemsQuery.isLoading &&
          items.length === 0 &&
          (viewAll || collections.length === 0) &&
          !error ? (
            <p data-testid="science-library-empty" className="text-muted-foreground text-xs">
              {t("Nothing here yet.")}
            </p>
          ) : null}
        </div>
      )}

      {query && rows.length === 0 ? (
        <p data-testid="library-type-empty" className="text-muted-foreground text-xs">
          {t("Nothing matches at this level")}
        </p>
      ) : null}

      {findOpen ? (
        <QuickFind
          ariaLabel={t("Find in library")}
          // This level's collections and their sub-collections (a level deeper), plus papers once
          // they show at this level — id prefixes (coll:/deep:/paper:) drive the pick.
          placeholder={showItems ? t("Find a collection or paper…") : t("Find a collection…")}
          items={finderEntries.map((e) => e.item)}
          emptyText={showItems ? t("Nothing matches at this level") : t("No matching collections")}
          onSelect={(item) => finderEntries.find((e) => e.item.id === item.id)?.run()}
          onClose={() => setFindOpen(false)}
        />
      ) : null}
    </section>
  )
}

const collectionToRow = (c: LibraryCollection): Row => ({
  type: "collection",
  key: c.key,
  name: c.name,
})

/** The entries whose label fuzzy-matches `query`, best match first (all, in order, when empty). */
function filterByQuery<T>(list: T[], label: (entry: T) => string, query: string): T[] {
  if (!query) return list
  return list
    .map((entry) => ({ entry, match: fuzzyMatch(query, label(entry)) }))
    .filter((e): e is { entry: T; match: NonNullable<typeof e.match> } => e.match !== null)
    .sort((a, b) => b.match.score - a.match.score)
    .map((e) => e.entry)
}
