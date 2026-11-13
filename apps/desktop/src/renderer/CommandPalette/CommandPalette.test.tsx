import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, expect, test, vi } from "vitest"

const command = vi.hoisted(() => ({ run: vi.fn() }))
const submenu = vi.hoisted(() => ({ preview: vi.fn(), apply: vi.fn() }))
const plain = vi.hoisted(() => ({ apply: vi.fn() }))
vi.mock("./usePaletteCommands", () => ({
  usePaletteCommands: () => [
    {
      id: "setting",
      label: "Change setting",
      group: "Settings",
      icon: () => null,
      run: command.run,
    },
    // Listed before Change theme, so ranking (not list order) must put Change theme first.
    {
      id: "theme-mode",
      label: "Change theme mode",
      group: "Settings",
      icon: () => null,
      submenu: {
        options: [["light", "Light"]],
        current: "light",
        preview: null,
        apply: plain.apply,
      },
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
    {
      id: "channel",
      label: "Change update channel",
      group: "Settings",
      icon: () => null,
      submenu: {
        options: [
          ["stable", "Stable"],
          ["beta", "Beta"],
        ],
        current: "stable",
        preview: null,
        apply: plain.apply,
      },
    },
  ],
}))
vi.mock("../i18n/language", () => ({ useTranslate: () => (text: string) => text }))

import { CommandPalette } from "./CommandPalette"

beforeEach(() => {
  submenu.preview.mockClear()
  submenu.apply.mockClear()
  plain.apply.mockReset()
})

const dimmed = () => screen.getByTestId("command-palette-dim").getAttribute("data-dim")

test("the top level lists one command per setting, not its options", () => {
  render(<CommandPalette onClose={vi.fn()} />)
  fireEvent.change(screen.getByTestId("command-palette-input"), { target: { value: "them" } })
  expect(
    screen.getAllByTestId("command-palette-item").map((item) => item.dataset.commandId),
  ).toEqual(["theme-mode", "theme"])
})

test("an exact label match ranks first, then labels starting with the query", () => {
  render(<CommandPalette onClose={vi.fn()} />)
  const input = screen.getByTestId("command-palette-input")
  const ids = () =>
    screen.getAllByTestId("command-palette-item").map((item) => item.dataset.commandId)
  fireEvent.change(input, { target: { value: "change theme" } })
  expect(ids()).toEqual(["theme", "theme-mode"])
  fireEvent.change(input, { target: { value: "Change theme m" } })
  expect(ids()?.[0]).toBe("theme-mode")
})

test("a sub-list without preview applies only on Enter and shows a failed write", async () => {
  const close = vi.fn()
  plain.apply.mockRejectedValueOnce(new Error("Settings could not be saved"))
  render(<CommandPalette onClose={close} />)
  fireEvent.click(screen.getByText("Change update channel"))
  expect(dimmed()).toBe("true")
  const input = screen.getByTestId("command-palette-input")
  fireEvent.keyDown(input, { key: "ArrowDown" })
  expect(plain.apply).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: "Enter" })
  await waitFor(() => expect(plain.apply).toHaveBeenCalledWith("beta"))
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Settings could not be saved"),
  )
  expect(close).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: "Enter" })
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
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
  expect(dimmed()).toBe("true")
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
  // A previewing sub-list leaves the app undimmed so the preview shows its real colors.
  expect(dimmed()).toBe("false")

  const input = screen.getByTestId("command-palette-input")
  fireEvent.keyDown(input, { key: "ArrowDown" })
  expect(submenu.preview).toHaveBeenLastCalledWith("dracula")
  fireEvent.mouseMove(screen.getAllByTestId("command-palette-item")[0] as HTMLElement)
  expect(submenu.preview).toHaveBeenLastCalledWith("default")
  fireEvent.keyDown(input, { key: "Escape" })
  expect(submenu.preview).toHaveBeenLastCalledWith(null)
  expect(submenu.apply).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledOnce()
})

test("typing filters a sub-list and Enter applies the highlighted choice", async () => {
  const close = vi.fn()
  const { unmount } = render(<CommandPalette onClose={close} />)
  fireEvent.click(screen.getByText("Change theme"))
  const input = screen.getByTestId("command-palette-input")
  fireEvent.change(input, { target: { value: "drac" } })
  expect(screen.getAllByTestId("command-palette-item").map((item) => item.textContent)).toEqual([
    "Dracula",
  ])
  fireEvent.keyDown(input, { key: "Enter" })
  await waitFor(() => expect(submenu.apply).toHaveBeenCalledWith("dracula"))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  // Closing after Enter keeps the applied choice instead of restoring the old one.
  unmount()
  expect(submenu.preview).not.toHaveBeenCalledWith(null)
})
