import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { expect, test, vi } from "vitest"

const command = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock("./usePaletteCommands", () => ({
  usePaletteCommands: () => [
    {
      id: "setting",
      label: "Change setting",
      group: "Settings",
      icon: () => null,
      run: command.run,
    },
  ],
}))
vi.mock("../i18n/language", () => ({ useTranslate: () => (text: string) => text }))

import { CommandPalette } from "./CommandPalette"

test("a rejected setting write stays visible and can be retried", async () => {
  const close = vi.fn()
  command.run
    .mockRejectedValueOnce(new Error("Settings could not be saved"))
    .mockResolvedValueOnce(undefined)
  render(<CommandPalette onClose={close} />)
  fireEvent.click(screen.getByTestId("command-palette-item"))
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Settings could not be saved"),
  )
  expect(close).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId("command-palette-item"))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
})
