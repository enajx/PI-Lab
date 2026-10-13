import { Menu, type MenuItemConstructorOptions } from "electron"
import { nativeText } from "../i18n/nativeLanguage"

/**
 * Install the application menu, deliberately binding **no** accelerator to ⌘W / Ctrl+W.
 *
 * Electron's default menu has a "Close Window" item (role `"close"`) bound to ⌘W; on the
 * lone PI Lab window that closed the window — and since macOS keeps the app alive with no
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

  const item = (
    role: NonNullable<MenuItemConstructorOptions["role"]>,
    label: Parameters<typeof nativeText>[0],
  ): MenuItemConstructorOptions => ({ role, label: nativeText(label) })

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: "PI Lab",
            submenu: [
              item("about", "About PI Lab"),
              { type: "separator" },
              item("hide", "Hide PI Lab"),
              item("hideOthers", "Hide Others"),
              item("unhide", "Show All"),
              { type: "separator" },
              item("quit", "Quit PI Lab"),
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : [
          {
            label: nativeText("File"),
            submenu: [item("quit", "Quit PI Lab")],
          } satisfies MenuItemConstructorOptions,
        ]),
    {
      label: nativeText("Edit"),
      submenu: [
        item("undo", "Undo"),
        item("redo", "Redo"),
        { type: "separator" },
        item("cut", "Cut"),
        item("copy", "Copy"),
        item("paste", "Paste"),
        item("pasteAndMatchStyle", "Paste and Match Style"),
        item("delete", "Delete"),
        item("selectAll", "Select All"),
      ],
    },
    {
      label: nativeText("View"),
      submenu: [
        item("reload", "Reload"),
        item("forceReload", "Force Reload"),
        item("toggleDevTools", "Toggle Developer Tools"),
        { type: "separator" },
        item("resetZoom", "Actual Size"),
        item("zoomIn", "Zoom In"),
        item("zoomOut", "Zoom Out"),
        { type: "separator" },
        item("togglefullscreen", "Toggle Full Screen"),
      ],
    },
    {
      label: nativeText("Window"),
      // Note: NO "Close" (⌘W) item here — that is the whole point of this custom menu.
      submenu: isMac
        ? [
            item("minimize", "Minimize"),
            item("zoom", "Zoom"),
            { type: "separator" },
            item("front", "Bring All to Front"),
          ]
        : [item("minimize", "Minimize"), item("zoom", "Zoom")],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
