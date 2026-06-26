import { Menu, type MenuItemConstructorOptions } from "electron"

/**
 * Install the application menu, deliberately binding **no** accelerator to ⌘W / Ctrl+W.
 *
 * Electron's default menu has a "Close Window" item (role `"close"`) bound to ⌘W; on the
 * lone Skipper window that closed the window — and since macOS keeps the app alive with no
 * window (`window-all-closed` is a no-op on darwin), it read as "the app exited". By owning
 * the menu and omitting any ⌘W item, the keystroke instead reaches the renderer, where the
 * project view closes the **active tab** (see `CentralPanel`). The window can still be closed
 * with the traffic-light button, and ⌘Q still quits.
 *
 * Everything else uses standard roles, so Copy/Paste, Reload, DevTools, Minimize/Zoom, About,
 * Hide, and Quit keep working unchanged.
 */
export function installAppMenu(): void {
  const isMac = process.platform === "darwin"

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ role: "appMenu" } satisfies MenuItemConstructorOptions]
      : [{ label: "File", submenu: [{ role: "quit" }] } satisfies MenuItemConstructorOptions]),
    { role: "editMenu" },
    { role: "viewMenu" },
    {
      label: "Window",
      // Note: NO "Close" (⌘W) item here — that is the whole point of this custom menu.
      submenu: isMac
        ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }]
        : [{ role: "minimize" }, { role: "zoom" }],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
