import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { app, dialog, Menu, type MenuItemConstructorOptions } from "electron"
import { nativeText } from "../i18n/nativeLanguage"
import { channelFromAppName } from "../identity/channel"
import { installCommand } from "../quickEdit/installCommand"

interface ReadyUpdateMenuItem {
  version: string
  restart: () => void
}

let readyUpdate: ReadyUpdateMenuItem | null = null

/** Refresh the native menu when a public update becomes ready or is cleared. */
export function setReadyUpdateMenuItem(item: ReadyUpdateMenuItem | null): void {
  readyUpdate = item
  installAppMenu()
}

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
  const appName = app.getName()
  const stable = channelFromAppName(appName) === "stable"

  const item = (
    role: NonNullable<MenuItemConstructorOptions["role"]>,
    label: Parameters<typeof nativeText>[0],
  ): MenuItemConstructorOptions => ({ role, label: nativeText(label) })

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: appName,
            submenu: [
              stable ? item("about", "About PI Lab") : { role: "about", label: `About ${appName}` },
              ...(app.isPackaged && stable
                ? [
                    {
                      label: "Install 'pilab' command",
                      click: () => {
                        const home = homedir()
                        const bin = join(home, ".local", "bin")
                        const script = join(process.resourcesPath, "bin", "pilab")
                        void installCommand(home, script)
                          .then((path) => {
                            const onPath = (process.env.PATH ?? "").split(delimiter).includes(bin)
                            const message = onPath
                              ? `Installed ${path}. Run: pilab /path/to/file.py`
                              : `Installed ${path}. Add this line to your shell setup, then open a new terminal:\n\nexport PATH="$HOME/.local/bin:$PATH"`
                            return dialog.showMessageBox({ type: "info", message })
                          })
                          .catch((error: unknown) => {
                            return dialog.showMessageBox({
                              type: "error",
                              message: `Could not install the pilab command: ${String(error)}`,
                            })
                          })
                      },
                    } satisfies MenuItemConstructorOptions,
                  ]
                : []),
              ...(readyUpdate
                ? ([
                    { label: `Ready to update to ${readyUpdate.version}`, enabled: false },
                    { label: "Restart to Update", click: readyUpdate.restart },
                  ] satisfies MenuItemConstructorOptions[])
                : []),
              { type: "separator" },
              stable ? item("hide", "Hide PI Lab") : { role: "hide", label: `Hide ${appName}` },
              item("hideOthers", "Hide Others"),
              item("unhide", "Show All"),
              { type: "separator" },
              stable ? item("quit", "Quit PI Lab") : { role: "quit", label: `Quit ${appName}` },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : [
          {
            label: nativeText("File"),
            submenu: [
              stable ? item("quit", "Quit PI Lab") : { role: "quit", label: `Quit ${appName}` },
            ],
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
