import {
  type AddPanelPositionOptions,
  type DockviewApi,
  type DockviewDidDropEvent,
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
  type Position,
  type SerializedDockview,
} from "dockview-react"
import "dockview-react/dist/styles/dockview.css"
import {
  createContext,
  type ReactNode,
  type Ref,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react"
import { FILE_DRAG_TYPE } from "../../../../../Editor/fileDrag"
import "./splitDock.css"

/** One tab the dock should show. `id` is stable: `file:<relPath>`, `session:<id>` or `run`. */
export interface DockItem {
  id: string
  /** Rendered as the tab header. */
  tab: (props: { visible: boolean; activate: () => void }) => ReactNode
  /** Rendered as the tab's content; stays mounted while hidden or moved. */
  content: (props: { visible: boolean }) => ReactNode
}

export interface SplitDockProps {
  /** Desired tabs, in order. The dock adds and removes tabs to match. */
  items: DockItem[]
  /**
   * Tabs from the saved layout that are still reopening (large files read after startup).
   * Their place in the layout is kept until they appear in `items` or stop restoring.
   */
  restoringIds: string[]
  /** The focused tab; the dock follows it and reports user focus through `onActivate`. */
  activeId: string | null
  onActivate: (id: string) => void
  /** A tree file was dropped and is not open yet; open it (it lands where it was dropped). */
  onOpenDroppedFile: (relPath: string) => void
  /** Where a new tab with this id goes when it first appears (e.g. run output below a file). */
  placementFor: (id: string) => AddPanelPositionOptions | undefined
  /** Shown when no tab is open, and in an empty split. */
  empty: ReactNode
  /** Layout saved from an earlier session; applied once when the dock mounts. */
  initialLayout: SerializedDockview | null
  onLayoutChange: (layout: SerializedDockview) => void
  /** The saved layout could not be loaded; the tabs open in one split instead. */
  onRestoreFailed: (message: string) => void
  handle: Ref<SplitDockHandle>
}

/** Split actions driven from outside the dock (keyboard shortcuts). */
export interface SplitDockHandle {
  /**
   * Open an empty split beside or below the focused split and focus it. Returns false,
   * doing nothing, when the focused split is already empty (a split still waiting).
   */
  splitFocused: (direction: "right" | "below") => boolean
}

export function fileItemId(relPath: string): string {
  return `file:${relPath}`
}

interface DockContextValue {
  items: Map<string, DockItem>
  empty: ReactNode
}

const DockContext = createContext<DockContextValue | null>(null)

function useDockContext(): DockContextValue {
  const value = useContext(DockContext)
  if (!value) throw new Error("SplitDock parts must render inside SplitDock")
  return value
}

/** Whether the panel's content is shown in its split, following dockview's visibility events. */
function usePanelVisible(api: IDockviewPanelProps["api"]): boolean {
  const [visible, setVisible] = useState(api.isVisible)
  useEffect(() => {
    setVisible(api.isVisible)
    const subscription = api.onDidVisibilityChange((event) => setVisible(event.isVisible))
    return () => subscription.dispose()
  }, [api])
  return visible
}

function DockContent({ api }: IDockviewPanelProps) {
  const item = useDockContext().items.get(api.id)
  const visible = usePanelVisible(api)
  return (
    <div className="flex h-full min-h-0 flex-col">{item ? item.content({ visible }) : null}</div>
  )
}

function DockTab({ api }: IDockviewPanelHeaderProps) {
  const item = useDockContext().items.get(api.id)
  const visible = usePanelVisible(api)
  return item ? item.tab({ visible, activate: () => api.setActive() }) : null
}

/**
 * Fills the split like {@link DockContent}: dockview mounts the watermark in a plain
 * block box, so without this flex column the empty state cannot grow to the split's
 * height and sits at the top under the tab bar.
 */
function DockEmpty() {
  return (
    <div data-testid="dock-empty" className="flex h-full min-h-0 flex-col">
      {useDockContext().empty}
    </div>
  )
}

const theme: DockviewTheme = { name: "pi-lab", className: "dockview-theme-pi-lab" }
const components = { content: DockContent }
const tabComponents = { tab: DockTab }

function directionFor(position: Position): "left" | "right" | "above" | "below" | "within" {
  if (position === "top") return "above"
  if (position === "bottom") return "below"
  if (position === "center") return "within"
  return position
}

function hasDraggedFile(event: DragEvent | PointerEvent): boolean {
  return event instanceof DragEvent && (event.dataTransfer?.types.includes(FILE_DRAG_TYPE) ?? false)
}

/**
 * The central panel's split layout. Each split has its own tab bar; tabs and files
 * dragged from the file tree show a drop preview (left, right, top, bottom half, or
 * a tab in the split under the mouse). Tab contents stay attached to the page while
 * hidden or moved, so terminals, editors and PDFs keep their state.
 */
export function SplitDock({
  items,
  restoringIds,
  activeId,
  onActivate,
  onOpenDroppedFile,
  placementFor,
  empty,
  initialLayout,
  onLayoutChange,
  onRestoreFailed,
  handle,
}: SplitDockProps) {
  const [api, setApi] = useState<DockviewApi | null>(null)
  /** Drop targets for files that are opening; consumed when their tab first appears. */
  const pendingDrops = useRef(new Map<string, AddPanelPositionOptions>())
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const onActivateRef = useRef(onActivate)
  onActivateRef.current = onActivate
  const placementForRef = useRef(placementFor)
  placementForRef.current = placementFor
  const onLayoutChangeRef = useRef(onLayoutChange)
  onLayoutChangeRef.current = onLayoutChange

  const onReady = (event: DockviewReadyEvent) => {
    if (initialLayout) {
      // The user chose this one exception to letting errors surface: a layout that no
      // longer loads (e.g. after a dockview format change) must not break the project
      // view on every open. The tabs open in one split, the failure is shown, and the
      // next layout change overwrites the bad layout.
      try {
        event.api.fromJSON(initialLayout)
      } catch (cause) {
        event.api.clear()
        onRestoreFailed(cause instanceof Error ? cause.message : String(cause))
      }
    }
    event.api.onDidLayoutChange(() => onLayoutChangeRef.current(event.api.toJSON()))
    event.api.onUnhandledDragOver((over) => {
      if (hasDraggedFile(over.nativeEvent)) over.accept()
    })
    event.api.onDidActivePanelChange(({ panel }) => {
      if (panel && panel.id !== activeIdRef.current) onActivateRef.current(panel.id)
    })
    // An empty split waits for content (⌘D, the file finder). Once another split gets
    // focus it is no longer waiting, e.g. after a cancelled agent chooser or a failed launch.
    event.api.onDidActiveGroupChange((active) => {
      for (const group of [...event.api.groups]) {
        if (group !== active && group.panels.length === 0) event.api.removeGroup(group)
      }
    })
    setApi(event.api)
  }

  // Match the dock's tabs to `items`: remove tabs that closed, add tabs that opened.
  useEffect(() => {
    if (!api) return
    const wanted = new Set([...items.map((item) => item.id), ...restoringIds])
    for (const panel of [...api.panels]) if (!wanted.has(panel.id)) panel.api.close()
    for (const item of items) {
      if (api.getPanel(item.id)) continue
      // Without a drop target or placement, a new tab joins the focused split (or the first
      // split while none has focus yet), never a split of its own.
      const fallback = api.activeGroup ?? api.groups[0]
      // A drop target whose split has since closed no longer applies.
      const dropped = pendingDrops.current.get(item.id)
      const droppedValid =
        dropped && "referenceGroup" in dropped
          ? api.groups.some((group) => group === dropped.referenceGroup)
          : dropped !== undefined
      const position =
        (droppedValid ? dropped : undefined) ??
        placementForRef.current(item.id) ??
        (fallback ? { referenceGroup: fallback, direction: "within" as const } : undefined)
      pendingDrops.current.delete(item.id)
      api.addPanel({
        id: item.id,
        component: "content",
        tabComponent: "tab",
        inactive: true,
        ...(position ? { position } : {}),
      })
    }
  }, [api, items, restoringIds])

  useImperativeHandle(
    handle,
    () => ({
      splitFocused: (direction) => {
        if (!api) return false
        const reference = api.activeGroup
        if (reference && reference.panels.length === 0) return false
        const group = api.addGroup(
          reference ? { referenceGroup: reference, direction } : { direction },
        )
        group.api.setActive()
        return true
      },
    }),
    [api],
  )

  // Follow the controller's focused tab only when it changes (or its tab first appears).
  // Re-applying it on every render would pull focus out of a split the user or a
  // shortcut just focused, such as a new empty split or the Run tab.
  const appliedActiveId = useRef<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: Re-check after tabs are added so a new tab can take focus.
  useEffect(() => {
    if (!api || !activeId || activeId === appliedActiveId.current) return
    const panel = api.getPanel(activeId)
    if (!panel) return
    appliedActiveId.current = activeId
    if (api.activePanel?.id !== activeId) panel.api.setActive()
  }, [api, activeId, items])

  const onDidDrop = (event: DockviewDidDropEvent) => {
    if (!api || !(event.nativeEvent instanceof DragEvent)) return
    const relPath = event.nativeEvent.dataTransfer?.getData(FILE_DRAG_TYPE)
    if (!relPath) return
    const id = fileItemId(relPath)
    const direction = directionFor(event.position)
    const existing = api.getPanel(id)
    if (existing) {
      // One tab per file: dropping an open file moves its tab.
      const group = event.group ?? api.addGroup({ direction })
      existing.api.moveTo({ group, position: event.group ? event.position : "center" })
      existing.api.setActive()
      return
    }
    pendingDrops.current.set(
      id,
      event.group ? { referenceGroup: event.group, direction } : { direction },
    )
    onOpenDroppedFile(relPath)
  }

  return (
    <DockContext.Provider value={{ items: new Map(items.map((item) => [item.id, item])), empty }}>
      <DockviewReact
        className="min-h-0 flex-1"
        theme={theme}
        components={components}
        tabComponents={tabComponents}
        watermarkComponent={DockEmpty}
        defaultRenderer="always"
        disableFloatingGroups
        onReady={onReady}
        onDidDrop={onDidDrop}
      />
    </DockContext.Provider>
  )
}
