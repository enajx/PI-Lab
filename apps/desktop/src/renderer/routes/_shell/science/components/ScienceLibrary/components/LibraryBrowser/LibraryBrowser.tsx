import { Button } from "@pi-lab/ui"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronRight, FileText, Folder, RefreshCw } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type {
  LibraryCollection,
  LibraryPaper,
} from "../../../../../../../../main/trpc/science/library"
import { QuickFind, type QuickFindItem } from "../../../../../../../QuickFind"
import { eventMatchesShortcut } from "../../../../../../../shortcuts/shortcuts"
import { useTRPC } from "../../../../../../../trpc/react"
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
}

interface Crumb {
  key: string
  name: string
}

/** A navigable row in the current view, in display order — the keyboard cursor walks these. */
type Row =
  | { type: "all-items" }
  | { type: "collection"; key: string; name: string }
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
 * a folder file; `⌘←`/`⌘↑` go back one level. `⌃` works as an alias for `⌘`. `Enter`/`⌘↵` is a
 * universal **activate**: it drills into a selected collection / "All items" row (like `⌘→`), or
 * opens a selected paper's local copy externally — a folder PDF via `openItem`, a Zotero item's
 * resolved attachment via `openZoteroItem` (surfacing a clear message when none is on disk).
 */
export function LibraryBrowser({ kind, canWrite, rootLabel }: LibraryBrowserProps) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [trail, setTrail] = useState<Crumb[]>([])
  const [viewAll, setViewAll] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  // The context-aware ⌘F finder over this level's collections, their immediate sub-collections
  // (one level deeper), and papers once they show at this level — see `finderEntries` below.
  const [findOpen, setFindOpen] = useState(false)
  // Surfaced when an "open externally" gesture (Enter / ⌘↵, or ⌘→/⌘↓ on a folder paper) can't
  // open the item — e.g. the file is gone, or a Zotero item has no local copy on disk.
  const [openError, setOpenError] = useState<string | null>(null)
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

  // The navigable rows for this view, in render order (root: All items + collections;
  // drilled: collections + items; All items: items). The cursor index points into this.
  const rows: Row[] = (() => {
    const collectionRows: Row[] =
      !viewAll && current == null
        ? [{ type: "all-items" }, ...collections.map((c) => collectionToRow(c))]
        : !viewAll
          ? collections.map((c) => collectionToRow(c))
          : []
    const paperRows: Row[] = showItems ? items.map((p) => ({ type: "paper", id: p.id }) as Row) : []
    return [...collectionRows, ...paperRows]
  })()
  // Clamp the raw cursor for reading (rows can shrink on refresh between view resets).
  const cursor = rows.length > 0 ? Math.min(Math.max(selectedIndex, 0), rows.length - 1) : 0
  const selectedRow: Row | undefined = rows[cursor]

  const openCollection = (c: Crumb) => {
    setViewAll(false)
    setTrail((t) => [...t, c])
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
      if (!result.ok) setOpenError(result.message ?? "Couldn't open the file.")
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : "Open failed.")
    }
  }
  // Activate the cursor row for ⌘→/⌘↓: enter a collection (or "All items"), or open a folder file.
  const enterSelected = () => {
    const row = rows[cursor]
    if (row?.type === "all-items") openAll()
    else if (row?.type === "collection") openCollection({ key: row.key, name: row.name })
    else if (row?.type === "paper" && kind === "folder") void openSelectedItem()
  }
  // Universal Enter / ⌘↵ activate: drill into a selected collection / "All items" row (like ⌘→),
  // or open a selected paper's local copy (folder or Zotero).
  const activateSelected = () => {
    const row = rows[cursor]
    if (row?.type === "all-items") openAll()
    else if (row?.type === "collection") openCollection({ key: row.key, name: row.name })
    else if (row?.type === "paper") void openSelectedItem()
  }
  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: trpc.science.library.listCollections.queryKey(),
    })
    void queryClient.invalidateQueries({ queryKey: trpc.science.library.listItems.queryKey() })
  }

  const onKeyDown = (event: KeyboardEvent) => {
    // The finder owns the keyboard while open, and we never hijack typing inside form fields.
    if (findOpen) return
    const active = document.activeElement
    if (
      active instanceof HTMLElement &&
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)
    )
      return
    const mod = event.metaKey || event.ctrlKey
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault()
        if (mod) {
          enterSelected() // ⌘↓ activates the row, same as ⌘→
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
          enterSelected()
        }
        return
      case "Enter":
        // Enter / ⌘↵ are a universal activate: drill into a selected collection / "All items"
        // row, or open a selected paper's local copy externally (folder or Zotero). We only bail
        // for text fields (handled above) — NOT for focused buttons: arrow-nav moves the cursor
        // without changing DOM focus, so after clicking any control (Open, Refresh) focus lingers
        // there; gating on button focus would wrongly swallow Enter for the navigated row.
        if (!selectedRow) return
        event.preventDefault()
        activateSelected()
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
  }, [trail, viewAll])

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
      run: () =>
        setTrail([
          ...trail,
          { key: parent.key, name: parent.name },
          { key: child.key, name: child.name },
        ]),
    })),
    ...(showItems
      ? items.map((p) => ({
          item: {
            id: `paper:${p.id}`,
            label: p.title,
            hint: p.authors.length > 0 ? p.authors.join(", ") : undefined,
            icon: FileText,
          },
          // Folder papers open like Enter does; Zotero papers (whose action is a flow) just get
          // the row cursor so the user can reach the row's Attach action.
          run: () => {
            if (kind === "folder") {
              openItem.mutate({ path: p.id })
              return
            }
            const index = rows.findIndex((row) => row.type === "paper" && row.id === p.id)
            if (index >= 0) setSelectedIndex(index)
          },
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
            data-feature-help="Return to the top level of the connected research library."
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
                data-feature-help="Return to this collection in the library path."
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
              <span className="text-foreground">All items</span>
            </span>
          ) : null}
        </nav>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="library-refresh"
          data-feature-label="Refresh library"
          data-feature-help="Reload collections and papers from the connected library source."
          className="h-7 shrink-0 gap-1.5 text-muted-foreground text-xs"
          disabled={isFetching}
          onClick={refresh}
        >
          <RefreshCw className="size-3.5" />
          {isFetching ? "Refreshing…" : "Refresh"}
        </Button>
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

      {!viewAll && !current ? (
        <div className="flex flex-col gap-2">
          <CollectionRow
            name="All items"
            testId="library-all-items"
            selected={selectedRow?.type === "all-items"}
            onClick={openAll}
          />
          {collectionsQuery.isLoading ? (
            <p className="text-muted-foreground text-xs">Loading collections…</p>
          ) : (
            collections.map(collectionRow)
          )}
          {!collectionsQuery.isLoading && collections.length === 0 && !error ? (
            <p data-testid="library-collections-empty" className="text-muted-foreground text-xs">
              No collections — open “All items” to browse everything.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {!viewAll ? collections.map(collectionRow) : null}
          {itemsQuery.isLoading ? (
            <p className="text-muted-foreground text-xs">Loading items…</p>
          ) : (
            items.map((paper) => (
              <LibraryItem
                key={paper.id}
                paper={paper}
                testId="library-item"
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
              Showing the first {items.length} items — open a subfolder to narrow the list.
            </p>
          ) : null}
          {!itemsQuery.isLoading &&
          items.length === 0 &&
          (viewAll || collections.length === 0) &&
          !error ? (
            <p data-testid="science-library-empty" className="text-muted-foreground text-xs">
              Nothing here yet.
            </p>
          ) : null}
        </div>
      )}

      {findOpen ? (
        <QuickFind
          ariaLabel="Find in library"
          // This level's collections and their sub-collections (a level deeper), plus papers once
          // they show at this level — id prefixes (coll:/deep:/paper:) drive the pick.
          placeholder={showItems ? "Find a collection or paper…" : "Find a collection…"}
          items={finderEntries.map((e) => e.item)}
          emptyText={showItems ? "Nothing matches at this level" : "No matching collections"}
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
