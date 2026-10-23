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
    openDashboard: vi.fn(async () => undefined),
    openProject: vi.fn(async () => undefined),
    openFile: vi.fn(async () => undefined),
    restartToUpdate: vi.fn(),
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

test("project monitor opens an active project without general app actions", async () => {
  const { api } = bridge({ projects: [{ id: "alpha", name: "Alpha", state: "working" }] })
  render(<TrayPopover />)
  fireEvent.click(await screen.findByRole("button", { name: /Alpha.*Working/ }))
  await waitFor(() => expect(api.openProject).toHaveBeenCalledWith("alpha"))
  expect(api.openDashboard).not.toHaveBeenCalled()
  expect(screen.queryByText("Background activity")).toBeNull()
  expect(screen.queryByRole("button", { name: "Open PI Lab" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Open File" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Quit" })).toBeNull()
})

test("shows project-opening failures", async () => {
  const { api, publish } = bridge({ projects: [] })
  vi.mocked(api.openProject).mockRejectedValue(new Error("Project unavailable"))
  render(<TrayPopover />)
  publish({ projects: [{ id: "alpha", name: "Alpha", state: "working" }] })
  fireEvent.click(await screen.findByRole("button", { name: /Alpha.*Working/ }))
  expect((await screen.findByRole("alert")).textContent).toContain("Project unavailable")
})

test("shows a downloaded update in the tray and offers an approved restart", async () => {
  const { api } = bridge({ projects: [], updateVersion: "0.1.2" })
  render(<TrayPopover />)

  expect(await screen.findByText("Ready to update to 0.1.2")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Restart to Update" }))
  expect(api.restartToUpdate).toHaveBeenCalledOnce()
  expect(api.openDashboard).not.toHaveBeenCalled()
})

test("panel background opens Dashboard", async () => {
  const { api } = bridge({ projects: [] })
  render(<TrayPopover />)
  await screen.findByText("No recent projects")
  fireEvent.click(screen.getByRole("button", { name: "Open Dashboard" }))
  await waitFor(() => expect(api.openDashboard).toHaveBeenCalledOnce())
  expect(api.openProject).not.toHaveBeenCalled()
})

test("empty content and header clicks open Dashboard", async () => {
  const { api } = bridge({ projects: [] })
  render(<TrayPopover />)
  fireEvent.click(await screen.findByText("No recent projects"))
  fireEvent.click(screen.getByText("PI Lab"))
  expect(api.openDashboard).toHaveBeenCalledTimes(2)
})
