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
let userQuitAction: () => void = () => app.quit()

/** Keep explicit quit behavior when the native menu is rebuilt for updates or language. */
export function setUserQuitAction(action: () => void): void {
  userQuitAction = action
}

/** Refresh the native menu when a public update becomes ready or is cleared. */
export function setReadyUpdateMenuItem(item: ReadyUpdateMenuItem | null): void {
  readyUpdate = item
  installAppMenu()
}

/** Install native app actions, including Cmd+W to keep the app running in the background. */
export function installAppMenu(): void {
  const isMac = process.platform === "darwin"
  const appName = app.getName()
  const stable = channelFromAppName(appName) === "stable"

  const item = (
    role: NonNullable<MenuItemConstructorOptions["role"]>,
    label: Parameters<typeof nativeText>[0],
  ): MenuItemConstructorOptions => ({ role, label: nativeText(label) })

  const quitItem: MenuItemConstructorOptions = {
    id: "user-quit",
    label: stable ? nativeText("Quit PI Lab") : `Quit ${appName}`,
    accelerator: "CommandOrControl+Q",
    click: () => userQuitAction(),
  }
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
              quitItem,
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : [
          {
            label: nativeText("File"),
            submenu: [quitItem],
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
      submenu: isMac
        ? [
            { label: "Move to background", accelerator: "Command+W", click: () => app.hide() },
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
