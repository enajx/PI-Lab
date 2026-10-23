import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { UpdateNotice } from "./UpdateNotice"

afterEach(() => vi.useRealTimers())

test("a ready-update notice closes after three seconds or on dismissal", () => {
  vi.useFakeTimers()
  const { rerender } = render(<UpdateNotice message="PI Lab 1.2 is ready to install on restart." />)
  expect(screen.getByRole("status").textContent).toContain("ready to install on restart")
  act(() => vi.advanceTimersByTime(2999))
  expect(screen.queryByRole("status")).not.toBeNull()
  act(() => vi.advanceTimersByTime(1))
  expect(screen.queryByRole("status")).toBeNull()
  rerender(<UpdateNotice message="Updated to PI Lab 1.2" />)
  fireEvent.click(screen.getByRole("button", { name: "Dismiss update notification" }))
  expect(screen.queryByRole("status")).toBeNull()
})
