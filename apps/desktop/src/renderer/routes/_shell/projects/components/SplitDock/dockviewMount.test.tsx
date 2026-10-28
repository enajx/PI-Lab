import { act, render, screen } from "@testing-library/react"
import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps } from "dockview-react"
import { useEffect } from "react"
import { beforeEach, expect, test } from "vitest"

let mounts = 0
let unmounts = 0

beforeEach(() => {
  mounts = 0
  unmounts = 0
})

function Counted(props: IDockviewPanelProps) {
  useEffect(() => {
    mounts += 1
    return () => {
      unmounts += 1
    }
  }, [])
  return <div data-testid={`content-${props.api.id}`}>counted</div>
}

/** Moving a tab to another split must not remount it (terminals and PDFs keep state). */
test("a panel moved to a new split keeps its mounted component", () => {
  let ready: DockviewReadyEvent | undefined
  render(
    <div style={{ width: 800, height: 600 }}>
      <DockviewReact
        components={{ counted: Counted }}
        defaultRenderer="always"
        onReady={(event) => {
          ready = event
        }}
      />
    </div>,
  )
  if (!ready) throw new Error("dockview did not report ready")
  const api = ready.api
  act(() => {
    api.addPanel({ id: "a", component: "counted" })
    api.addPanel({ id: "b", component: "counted" })
  })
  expect(mounts).toBe(2)
  // "a" is now a hidden tab behind "b"; its DOM must stay attached so scroll position survives.
  expect(screen.getByTestId("content-a").isConnected).toBe(true)

  const panel = api.getPanel("a")
  if (!panel) throw new Error("panel a missing")
  act(() => {
    panel.api.moveTo({ group: panel.group, position: "right" })
  })
  expect(api.groups.length).toBe(2)
  expect(mounts).toBe(2)
  expect(unmounts).toBe(0)
  expect(screen.getByTestId("content-a").isConnected).toBe(true)
})
