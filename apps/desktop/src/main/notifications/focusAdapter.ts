import type { AppFocusAdapter } from "./service"

export interface FocusableWindow {
  isMinimized: () => boolean
  restore: () => void
  show: () => void
  focus: () => void
}

export interface AppFocusDependencies {
  hasFocusedWindow: () => boolean
  getWindows: () => FocusableWindow[]
  createWindow: () => FocusableWindow
  focusApp: () => void
}

/**
 * Restore an existing window or create one through the app's normal boot path.
 * The latter is essential on macOS, where the app can remain alive after every
 * BrowserWindow closes.
 */
export function createAppFocusAdapter(dependencies: AppFocusDependencies): AppFocusAdapter {
  return {
    isFocused: dependencies.hasFocusedWindow,
    restoreAndFocus: (): void => {
      const window = dependencies.getWindows()[0] ?? dependencies.createWindow()
      if (window.isMinimized()) window.restore()
      window.show()
      dependencies.focusApp()
      window.focus()
    },
  }
}
