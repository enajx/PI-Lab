import { fireEvent, render, waitFor } from "@testing-library/react"
import { expect, test, vi } from "vitest"
import { ComposeLine } from "./ComposeLine"

// The component alone with a fake `send`; the real send path (server message
// IDs, bracketed paste, a dropped connection) is in server/terminalConnection.test.ts.
test("compose line: Enter sends and shows Sending until the reply, Shift+Enter adds a line, Up and Down recall sent messages, Escape goes to the terminal", async () => {
  let reply: () => void = () => {}
  const send = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        reply = resolve
      }),
  )
  const focusTerminal = vi.fn()
  const view = render(<ComposeLine send={send} focusTerminal={focusTerminal} />)
  const input = view.getByTestId("terminal-compose-input") as HTMLTextAreaElement

  fireEvent.change(input, { target: { value: "first line" } })
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
  expect(send).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: "first line\nsecond line" } })
  fireEvent.keyDown(input, { key: "Enter" })
  expect(send).toHaveBeenCalledWith("first line\nsecond line")
  expect(input.value).toBe("")
  expect(view.getByTestId("terminal-compose-sending").textContent).toContain("first line")
  reply()
  await waitFor(() => expect(view.queryByTestId("terminal-compose-sending")).toBeNull())

  fireEvent.change(input, { target: { value: "other" } })
  fireEvent.keyDown(input, { key: "Enter" })
  reply()
  fireEvent.keyDown(input, { key: "ArrowUp" })
  expect(input.value).toBe("other")
  input.selectionStart = 0
  input.selectionEnd = 0
  fireEvent.keyDown(input, { key: "ArrowUp" })
  expect(input.value).toBe("first line\nsecond line")
  input.selectionStart = input.value.length
  input.selectionEnd = input.value.length
  fireEvent.keyDown(input, { key: "ArrowDown" })
  expect(input.value).toBe("other")

  fireEvent.keyDown(input, { key: "Escape" })
  expect(focusTerminal).toHaveBeenCalled()
})
