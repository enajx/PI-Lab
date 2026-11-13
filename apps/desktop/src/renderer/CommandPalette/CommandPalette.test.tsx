import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, expect, test, vi } from "vitest"

const command = vi.hoisted(() => ({ run: vi.fn() }))
const submenu = vi.hoisted(() => ({ preview: vi.fn(), apply: vi.fn() }))
vi.mock("./usePaletteCommands", () => ({
  usePaletteCommands: () => [
    {
      id: "setting",
      label: "Change setting",
      group: "Settings",
      icon: () => null,
      run: command.run,
    },
    {
      id: "theme",
      label: "Change theme",
      group: "Settings",
      icon: () => null,
      submenu: {
        options: [
          ["default", "Default"],
          ["nord", "Nord"],
          ["dracula", "Dracula"],
        ],
        current: "nord",
        preview: submenu.preview,
        apply: submenu.apply,
      },
    },
  ],
}))
vi.mock("../i18n/language", () => ({ useTranslate: () => (text: string) => text }))

import { CommandPalette } from "./CommandPalette"

beforeEach(() => {
  submenu.preview.mockClear()
  submenu.apply.mockClear()
})

test("a rejected setting write stays visible and can be retried", async () => {
  const close = vi.fn()
  command.run
    .mockRejectedValueOnce(new Error("Settings could not be saved"))
    .mockResolvedValueOnce(undefined)
  render(<CommandPalette onClose={close} />)
  fireEvent.click(screen.getByText("Change setting"))
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Settings could not be saved"),
  )
  expect(close).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText("Change setting"))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
})

test("a sub-list previews the highlighted choice, Enter applies it, Escape restores", () => {
  const close = vi.fn()
  render(<CommandPalette onClose={close} />)
  fireEvent.click(screen.getByText("Change theme"))
  const ids = () =>
    screen.getAllByTestId("command-palette-item").map((item) => item.dataset.commandId)
  expect(ids()).toEqual(["default", "nord", "dracula"])
  const highlighted = () =>
    screen
      .getAllByTestId("command-palette-item")
      .find((item) => item.getAttribute("data-highlighted") === "true")?.dataset.commandId
  expect(highlighted()).toBe("nord")
  expect(submenu.preview).not.toHaveBeenCalled()

  const input = screen.getByTestId("command-palette-input")
  fireEvent.keyDown(input, { key: "ArrowDown" })
  expect(submenu.preview).toHaveBeenLastCalledWith("dracula")
  fireEvent.mouseEnter(screen.getAllByTestId("command-palette-item")[0] as HTMLElement)
  expect(submenu.preview).toHaveBeenLastCalledWith("default")
  fireEvent.keyDown(input, { key: "Escape" })
  expect(submenu.preview).toHaveBeenLastCalledWith(null)
  expect(submenu.apply).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledOnce()
})

test("typing filters a sub-list and Enter applies the highlighted choice", () => {
  const close = vi.fn()
  render(<CommandPalette onClose={close} />)
  fireEvent.click(screen.getByText("Change theme"))
  const input = screen.getByTestId("command-palette-input")
  fireEvent.change(input, { target: { value: "drac" } })
  expect(screen.getAllByTestId("command-palette-item").map((item) => item.textContent)).toEqual([
    "Dracula",
  ])
  fireEvent.keyDown(input, { key: "Enter" })
  expect(submenu.apply).toHaveBeenCalledWith("dracula")
  expect(close).toHaveBeenCalledOnce()
})
