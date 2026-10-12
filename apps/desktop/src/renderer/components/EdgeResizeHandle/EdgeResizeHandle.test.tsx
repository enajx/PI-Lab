import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { EdgeResizeHandle } from "./EdgeResizeHandle"

/** jsdom lacks pointer events and capture; callbacks run through actual DOM events. */
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number

  constructor(type: string, init: PointerEventInit) {
    super(type, init)
    this.pointerId = init.pointerId ?? 1
  }
}

beforeEach(() => vi.stubGlobal("PointerEvent", TestPointerEvent))
afterEach(() => vi.unstubAllGlobals())

function prepareHandle(): HTMLElement {
  const handle = screen.getByTestId("resize")
  handle.setPointerCapture = vi.fn()
  handle.hasPointerCapture = vi.fn(() => true)
  handle.releasePointerCapture = vi.fn()
  return handle
}

test("reports clamped live widths and commits the drag once with the latest callback", () => {
  const onResize = vi.fn()
  const onResizeEnd = vi.fn()
  const latestResize = vi.fn()
  const latestEnd = vi.fn()
  const props = { side: "left" as const, width: 200, min: 100, max: 300, testId: "resize" }
  const view = render(<EdgeResizeHandle {...props} onResize={onResize} onResizeEnd={onResizeEnd} />)
  const handle = prepareHandle()
  fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 7 })
  fireEvent.pointerMove(window, { clientX: 75, pointerId: 7 })
  expect(onResize).toHaveBeenLastCalledWith(225)
  expect(onResizeEnd).not.toHaveBeenCalled()

  view.rerender(<EdgeResizeHandle {...props} onResize={latestResize} onResizeEnd={latestEnd} />)
  fireEvent.pointerMove(window, { clientX: -100, pointerId: 7 })
  expect(latestResize).toHaveBeenLastCalledWith(300)
  fireEvent.pointerUp(window, { clientX: -100, pointerId: 7 })
  fireEvent.pointerUp(window, { clientX: -100, pointerId: 7 })
  expect(onResizeEnd).not.toHaveBeenCalled()
  expect(latestEnd).toHaveBeenCalledExactlyOnceWith(300)
  expect(handle.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7)
  fireEvent.pointerMove(window, { clientX: 0, pointerId: 7 })
  expect(latestResize).toHaveBeenCalledTimes(1)
})

test("ignores other pointers and cancels or unmounts a drag without committing", () => {
  const onResize = vi.fn()
  const onResizeEnd = vi.fn()
  const view = render(
    <EdgeResizeHandle
      side="right"
      width={200}
      min={100}
      max={300}
      onResize={onResize}
      onResizeEnd={onResizeEnd}
      testId="resize"
    />,
  )
  const handle = prepareHandle()
  fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 7 })
  fireEvent.pointerMove(window, { clientX: 120, pointerId: 8 })
  fireEvent.pointerUp(window, { clientX: 120, pointerId: 8 })
  expect(onResize).not.toHaveBeenCalled()
  expect(onResizeEnd).not.toHaveBeenCalled()
  fireEvent.pointerMove(window, { clientX: 125, pointerId: 7 })
  expect(onResize).toHaveBeenLastCalledWith(225)
  fireEvent.pointerCancel(window, { pointerId: 7 })
  fireEvent.pointerUp(window, { clientX: 125, pointerId: 7 })
  fireEvent.pointerMove(window, { clientX: 130, pointerId: 7 })
  expect(onResize).toHaveBeenCalledTimes(1)
  expect(onResizeEnd).not.toHaveBeenCalled()

  fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 7 })
  view.unmount()
  fireEvent.pointerMove(window, { clientX: 150, pointerId: 7 })
  fireEvent.pointerUp(window, { clientX: 150, pointerId: 7 })
  expect(onResize).toHaveBeenCalledTimes(1)
  expect(onResizeEnd).not.toHaveBeenCalled()
})

test("does not commit a click without a width change", () => {
  const onResizeEnd = vi.fn()
  render(
    <EdgeResizeHandle
      side="right"
      width={200}
      min={100}
      max={300}
      onResize={vi.fn()}
      onResizeEnd={onResizeEnd}
      testId="resize"
    />,
  )
  fireEvent.pointerDown(prepareHandle(), { button: 0, clientX: 100, pointerId: 7 })
  fireEvent.pointerUp(window, { clientX: 100, pointerId: 7 })
  expect(onResizeEnd).not.toHaveBeenCalled()
})
