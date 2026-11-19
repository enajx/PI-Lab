/**
 * tRPC paths the desktop app serves itself over Electron IPC instead of the
 * server: native dialogs and window calls (`system.*`), notification sound,
 * click and error events for this device, the microphone, and the
 * Electron-side halves of Finder, clipboard and "open with default app"
 * actions (they ask the server for the checked path, then act on this device).
 * Every other path goes to the PI Lab server.
 */
export const DESKTOP_PATH_PREFIXES = ["desktop.", "system.", "notifications."] as const

export const DESKTOP_PATHS = [
  "dictation.status",
  "dictation.requestMicrophone",
  "dictation.openMicrophoneSettings",
  "files.reveal",
  "files.copyPath",
  "documents.openInBrowser",
  "notebooks.openInBrowser",
  "science.library.openItem",
  "science.library.openZoteroItem",
] as const

/** True when the desktop app serves this path (see {@link DESKTOP_PATHS}). */
export function isDesktopPath(path: string): boolean {
  return (
    (DESKTOP_PATHS as readonly string[]).includes(path) ||
    DESKTOP_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))
  )
}
