import { fireEvent, render, screen } from "@testing-library/react"
import { useRef } from "react"
import { expect, test, vi } from "vitest"
import { usePopupDismiss } from "./usePopupDismiss"

function Popup({ open, onClose, testId }: { open: boolean; onClose: () => void; testId: string }) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  usePopupDismiss(open, [rootRef], onClose)
  return (
    <div ref={rootRef} data-testid={testId}>
      inside
    </div>
  )
}

test("an open popup closes on an outside mousedown or pointerdown and Escape, not inside, and stays open on window blur", () => {
  const onClose = vi.fn()
  render(
    <>
      <Popup open onClose={onClose} testId="popup" />
      <div data-testid="outside">outside</div>
    </>,
  )
  fireEvent.mouseDown(screen.getByTestId("popup"))
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.mouseDown(screen.getByTestId("outside"))
  expect(onClose).toHaveBeenCalledTimes(1)
  fireEvent.pointerDown(screen.getByTestId("outside"))
  expect(onClose).toHaveBeenCalledTimes(2)
  fireEvent.keyDown(window, { key: "Escape" })
  expect(onClose).toHaveBeenCalledTimes(3)
  // A native dialog the popup opened (a folder picker) takes the focus; the popup's
  // flow must go on.
  fireEvent.blur(window)
  expect(onClose).toHaveBeenCalledTimes(3)
})

test("a closed popup ignores outside clicks, Escape and blur", () => {
  const onClose = vi.fn()
  render(<Popup open={false} onClose={onClose} testId="popup" />)
  fireEvent.mouseDown(document.body)
  fireEvent.keyDown(window, { key: "Escape" })
  fireEvent.blur(window)
  expect(onClose).not.toHaveBeenCalled()
})

test("the page is marked while any popup is open, so window drag regions take clicks", () => {
  const root = document.documentElement
  const view = render(
    <>
      <Popup open onClose={vi.fn()} testId="a" />
      <Popup open onClose={vi.fn()} testId="b" />
    </>,
  )
  expect(root.hasAttribute("data-popup-open")).toBe(true)
  view.rerender(
    <>
      <Popup open={false} onClose={vi.fn()} testId="a" />
      <Popup open onClose={vi.fn()} testId="b" />
    </>,
  )
  expect(root.hasAttribute("data-popup-open")).toBe(true)
  view.rerender(
    <>
      <Popup open={false} onClose={vi.fn()} testId="a" />
      <Popup open={false} onClose={vi.fn()} testId="b" />
    </>,
  )
  expect(root.hasAttribute("data-popup-open")).toBe(false)
})
