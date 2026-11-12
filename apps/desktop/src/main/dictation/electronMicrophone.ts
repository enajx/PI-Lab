import { shell, systemPreferences } from "electron"
import type { MicrophonePort, MicrophoneStatus } from "./service"

const PRIVACY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"

/** macOS microphone permission through Electron's systemPreferences. */
export const electronMicrophone: MicrophonePort = {
  status: (): MicrophoneStatus => {
    const status = systemPreferences.getMediaAccessStatus("microphone")
    // "unknown" means macOS has not recorded a choice yet.
    return status === "unknown" ? "not-determined" : status
  },
  request: () => systemPreferences.askForMediaAccess("microphone"),
  openSettings: () => shell.openExternal(PRIVACY_SETTINGS_URL),
}
