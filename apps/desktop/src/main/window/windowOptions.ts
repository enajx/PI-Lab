import type { BrowserWindowConstructorOptions } from "electron"

export function buildMainWindowOptions(
  iconPath: string | null,
  preloadPath: string,
  platform: NodeJS.Platform,
): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 800,
    // Floor on the window size so the sidebar + main panes can't be crushed to a
    // broken layout (the icon rail + a usable pane need this much room).
    minWidth: 900,
    minHeight: 600,
    show: false,
    // Light by default; this is only the pre-paint flash color before the
    // renderer mounts its theme.
    backgroundColor: "#ffffff",
    ...(iconPath ? { icon: iconPath } : {}),
    // macOS: hide the title bar and inset the traffic lights so the app's own
    // surface (the sidebar) extends to the top edge and the chrome "blends" —
    // no separate title-bar strip. The renderer marks a drag region at the top.
    ...(platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 18 } }
      : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  }
}
