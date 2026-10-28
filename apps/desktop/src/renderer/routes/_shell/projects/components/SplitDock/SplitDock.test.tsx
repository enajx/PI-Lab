import { act, render, waitFor } from "@testing-library/react"
import type { SerializedDockview } from "dockview-react"
import { createRef } from "react"
import { expect, test } from "vitest"
import { type DockItem, SplitDock, type SplitDockHandle } from "./SplitDock"

function item(id: string): DockItem {
  return { id, tab: () => <span>{id}</span>, content: () => <div data-testid={`content-${id}`} /> }
}

function groupCount(container: HTMLElement): number {
  return container.querySelectorAll(".dv-groupview").length
}

function tabsPerSplit(container: HTMLElement): number[] {
  return [...container.querySelectorAll(".dv-groupview")].map(
    (group) => group.querySelectorAll(".dv-tab").length,
  )
}

function renderDock(
  items: DockItem[],
  initialLayout: SerializedDockview | null,
  onLayoutChange: (layout: SerializedDockview) => void,
  activeId: string | null,
  restoringIds: string[],
) {
  const handle = createRef<SplitDockHandle>()
  const restoreFailures: string[] = []
  const props = {
    onRestoreFailed: (message: string) => restoreFailures.push(message),
    onActivate: () => {},
    onOpenDroppedFile: () => {},
    placementFor: () => undefined,
    empty: <p>empty</p>,
    initialLayout,
    onLayoutChange,
    handle,
  }
  const view = render(
    <div style={{ width: 800, height: 600 }}>
      <SplitDock items={items} activeId={activeId} restoringIds={restoringIds} {...props} />
    </div>,
  )
  const rerender = (next: DockItem[], nextRestoringIds: string[], nextActiveId: string | null) =>
    view.rerender(
      <div style={{ width: 800, height: 600 }}>
        <SplitDock
          items={next}
          activeId={nextActiveId}
          restoringIds={nextRestoringIds}
          {...props}
        />
      </div>,
    )
  return { ...view, handle, rerender, restoreFailures }
}

/** A split made in one session comes back when the project reopens with the saved layout. */
test("a saved layout restores the splits", async () => {
  let saved: SerializedDockview | null = null
  const first = renderDock(
    [item("file:a.md")],
    null,
    (layout) => {
      saved = layout
    },
    null,
    [],
  )
  act(() => first.handle.current?.splitFocused("right"))
  first.rerender([item("file:a.md"), item("file:b.md")], [], null)
  expect(groupCount(first.container)).toBe(2)
  await waitFor(() => expect(saved).not.toBeNull())
  first.unmount()

  if (!saved) throw new Error("layout was not reported")
  const second = renderDock([item("file:a.md"), item("file:b.md")], saved, () => {}, null, [])
  expect(groupCount(second.container)).toBe(2)
})

/** Tabs restored without a saved layout open as tabs of one split, not one split each. */
test("tabs added together share one split", () => {
  const dock = renderDock(
    [item("file:a.md"), item("file:b.md"), item("session:pane-1")],
    null,
    () => {},
    null,
    [],
  )
  expect(groupCount(dock.container)).toBe(1)
})

/** After ⌘D, a re-render must not pull focus back, so the next new tab lands in the new split. */
test("a new tab lands in the split opened by the shortcut", () => {
  const dock = renderDock([item("session:pane-1")], null, () => {}, "session:pane-1", [])
  act(() => dock.handle.current?.splitFocused("right"))
  dock.rerender([item("session:pane-1")], [], "session:pane-1")
  dock.rerender([item("session:pane-1"), item("session:pane-2")], [], "session:pane-1")
  expect(tabsPerSplit(dock.container)).toEqual([1, 1])
})

/** Pressing the shortcut again while the new split is still empty adds no second empty split. */
test("splitting an empty split does nothing", () => {
  const dock = renderDock([item("file:a.md")], null, () => {}, null, [])
  act(() => dock.handle.current?.splitFocused("right"))
  act(() => dock.handle.current?.splitFocused("right"))
  expect(groupCount(dock.container)).toBe(2)
})

/** A saved layout that cannot be loaded falls back to one split and reports why. */
test("an unloadable saved layout falls back to one split with a notice", () => {
  const broken = {
    grid: { root: { type: "nonsense" } },
    panels: {},
  } as unknown as SerializedDockview
  const dock = renderDock([item("file:a.md"), item("file:b.md")], broken, () => {}, null, [])
  expect(dock.restoreFailures).toHaveLength(1)
  expect(tabsPerSplit(dock.container)).toEqual([2])
})

/** A restored file that reopens late (large files read after startup) keeps its saved split. */
test("a tab still being restored keeps its place in the saved layout", async () => {
  let saved: SerializedDockview | null = null
  const first = renderDock(
    [item("file:a.md")],
    null,
    (layout) => {
      saved = layout
    },
    null,
    [],
  )
  act(() => first.handle.current?.splitFocused("right"))
  first.rerender([item("file:a.md"), item("file:big.csv")], [], null)
  await waitFor(() => expect(saved).not.toBeNull())
  first.unmount()

  if (!saved) throw new Error("layout was not reported")
  const second = renderDock([item("file:a.md")], saved, () => {}, null, ["file:big.csv"])
  expect(groupCount(second.container)).toBe(2)
  second.rerender([item("file:a.md"), item("file:big.csv")], [], null)
  expect(tabsPerSplit(second.container)).toEqual([1, 1])
})

/** An empty split left behind (e.g. a failed terminal launch) closes once another split gets focus. */
test("an empty split closes when another split gets focus", () => {
  const dock = renderDock([item("file:a.md")], null, () => {}, null, [])
  act(() => dock.handle.current?.splitFocused("right"))
  expect(groupCount(dock.container)).toBe(2)
  act(() => dock.rerender([item("file:a.md")], [], "file:a.md"))
  expect(groupCount(dock.container)).toBe(1)
})
