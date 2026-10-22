import type { MenuItemConstructorOptions } from "electron"

export interface TrayMenuActions {
  openApp(): Promise<void>
  newProject(): Promise<void>
  hideIcon(): Promise<void>
  restartToUpdate(): void
  quit(): void
}

/** Build the native right-click actions without changing the left-click monitor. */
export function trayMenuTemplate(
  actions: TrayMenuActions,
  updateVersion: string | null,
  onError: (label: string, error: unknown) => void,
  canHideIcon: boolean,
): MenuItemConstructorOptions[] {
  const run = (label: string, action: () => Promise<void>): void => {
    void action().catch((error: unknown) => onError(label, error))
  }
  return [
    { label: "Open PI Lab", click: () => run("Open PI Lab", actions.openApp) },
    { label: "New Project", click: () => run("New Project", actions.newProject) },
    ...(canHideIcon
      ? [{ label: "Hide Icon", click: () => run("Hide Icon", actions.hideIcon) }]
      : []),
    ...(updateVersion
      ? [
          { type: "separator" as const },
          { label: "Restart to Update", click: actions.restartToUpdate },
        ]
      : []),
    { type: "separator" },
    { label: "Quit PI Lab", click: actions.quit },
  ]
}
