import { expect, test, vi } from "vitest"
import { trayMenuTemplate } from "./trayMenu"

function click(items: ReturnType<typeof trayMenuTemplate>, label: string): void {
  const item = items.find((entry) => entry.label === label)
  if (!item?.click) throw new Error(`Missing tray menu item: ${label}`)
  ;(item.click as () => void)()
}

test("right-click menu offers app actions and starts New Project", () => {
  const actions = {
    openApp: vi.fn(async () => undefined),
    newProject: vi.fn(async () => undefined),
    quit: vi.fn(),
    restartToUpdate: vi.fn(),
  }
  const items = trayMenuTemplate(actions, null, vi.fn())
  expect(items.filter((item) => item.label).map((item) => item.label)).toEqual([
    "Open PI Lab",
    "New Project",
    "Quit PI Lab",
  ])
  click(items, "New Project")
  expect(actions.newProject).toHaveBeenCalledOnce()
  expect(actions.openApp).not.toHaveBeenCalled()
})

test("ready updates appear in the menu and action failures are reported", async () => {
  const onError = vi.fn()
  const actions = {
    openApp: vi.fn(async () => undefined),
    newProject: vi.fn(async () => {
      throw new Error("Project chooser failed")
    }),
    quit: vi.fn(),
    restartToUpdate: vi.fn(),
  }
  const items = trayMenuTemplate(actions, "0.1.2", onError)
  click(items, "Restart to Update")
  expect(actions.restartToUpdate).toHaveBeenCalledOnce()
  click(items, "New Project")
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("New Project", expect.any(Error)))
})

test("the always-visible icon cannot be hidden from its menu", () => {
  const actions = {
    openApp: vi.fn(async () => undefined),
    newProject: vi.fn(async () => undefined),
    quit: vi.fn(),
    restartToUpdate: vi.fn(),
  }
  const items = trayMenuTemplate(actions, null, vi.fn())
  expect(items.some((item) => item.label === "Hide Icon")).toBe(false)
})
