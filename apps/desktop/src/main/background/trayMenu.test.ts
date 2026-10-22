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
    hideIcon: vi.fn(async () => undefined),
    quit: vi.fn(),
    restartToUpdate: vi.fn(),
  }
  const items = trayMenuTemplate(actions, null, vi.fn(), true)
  expect(items.filter((item) => item.label).map((item) => item.label)).toEqual([
    "Open PI Lab",
    "New Project",
    "Hide Icon",
    "Quit PI Lab",
  ])
  click(items, "New Project")
  expect(actions.newProject).toHaveBeenCalledOnce()
  expect(actions.openApp).not.toHaveBeenCalled()
  click(items, "Hide Icon")
  expect(actions.hideIcon).toHaveBeenCalledOnce()
})

test("ready updates appear in the menu and action failures are reported", async () => {
  const onError = vi.fn()
  const actions = {
    openApp: vi.fn(async () => undefined),
    newProject: vi.fn(async () => {
      throw new Error("Project chooser failed")
    }),
    hideIcon: vi.fn(async () => undefined),
    quit: vi.fn(),
    restartToUpdate: vi.fn(),
  }
  const items = trayMenuTemplate(actions, "0.1.2", onError, true)
  click(items, "Restart to Update")
  expect(actions.restartToUpdate).toHaveBeenCalledOnce()
  click(items, "New Project")
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("New Project", expect.any(Error)))
})

test("Hide Icon is only offered for the macOS menu bar", () => {
  const actions = {
    openApp: vi.fn(async () => undefined),
    newProject: vi.fn(async () => undefined),
    hideIcon: vi.fn(async () => undefined),
    quit: vi.fn(),
    restartToUpdate: vi.fn(),
  }
  const items = trayMenuTemplate(actions, null, vi.fn(), false)
  expect(items.some((item) => item.label === "Hide Icon")).toBe(false)
})
