import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import type { BackgroundTrayBridge, BackgroundTraySnapshot } from "../../shared/backgroundTray"
import { TrayPopover } from "./TrayPopover"

function bridge(initial: BackgroundTraySnapshot) {
  let listener: ((snapshot: BackgroundTraySnapshot) => void) | null = null
  const api: BackgroundTrayBridge = {
    getSnapshot: vi.fn(async () => initial),
    subscribe: vi.fn((next) => {
      listener = next
      return () => {
        listener = null
      }
    }),
    openProject: vi.fn(async () => undefined),
    openApp: vi.fn(async () => undefined),
    openFile: vi.fn(async () => undefined),
    restartToUpdate: vi.fn(),
    quit: vi.fn(),
  }
  Object.defineProperty(window, "piLab", { configurable: true, value: { backgroundTray: api } })
  return { api, publish: (snapshot: BackgroundTraySnapshot) => listener?.(snapshot) }
}

afterEach(() => {
  Reflect.deleteProperty(window, "piLab")
})

test("shows working and waiting projects and follows live changes", async () => {
  const control = bridge({
    projects: [
      { id: "alpha", name: "Alpha", state: "working" },
      { id: "beta", name: "Beta", state: "waiting" },
    ],
  })
  render(<TrayPopover />)

  expect(await screen.findByRole("button", { name: /Alpha.*Working/ })).toBeTruthy()
  expect(screen.getByRole("button", { name: /Beta.*Waiting/ })).toBeTruthy()

  control.publish({ projects: [{ id: "beta", name: "Beta", state: "working" }] })
  await waitFor(() => expect(screen.queryByRole("button", { name: /Alpha/ })).toBeNull())
  expect(screen.getByRole("button", { name: /Beta.*Working/ })).toBeTruthy()
})

test("project and footer actions call the native bridge", async () => {
  const { api } = bridge({ projects: [{ id: "alpha", name: "Alpha", state: "working" }] })
  render(<TrayPopover />)
  fireEvent.click(await screen.findByRole("button", { name: /Alpha.*Working/ }))
  fireEvent.click(screen.getByRole("button", { name: "Open PI Lab" }))
  fireEvent.click(screen.getByRole("button", { name: "Open File" }))
  fireEvent.click(screen.getByRole("button", { name: "Quit" }))

  await waitFor(() => expect(api.openProject).toHaveBeenCalledWith("alpha"))
  await waitFor(() => expect(api.openApp).toHaveBeenCalledOnce())
  await waitFor(() => expect(api.openFile).toHaveBeenCalledOnce())
  expect(api.quit).toHaveBeenCalledOnce()
})

test("shows native action failures", async () => {
  const { api } = bridge({ projects: [] })
  vi.mocked(api.openFile).mockRejectedValue(new Error("Dialog unavailable"))
  render(<TrayPopover />)
  fireEvent.click(screen.getByRole("button", { name: "Open File" }))
  expect((await screen.findByRole("alert")).textContent).toContain("Dialog unavailable")
})

test("shows a downloaded update in the tray and offers an approved restart", async () => {
  const { api } = bridge({ projects: [], updateVersion: "0.1.2" })
  render(<TrayPopover />)

  expect(await screen.findByText("Ready to update to 0.1.2")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Restart to Update" }))
  expect(api.restartToUpdate).toHaveBeenCalledOnce()
})
