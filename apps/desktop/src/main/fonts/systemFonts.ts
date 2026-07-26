import { execFile } from "node:child_process"

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const DEFAULT_DETECTION_TIMEOUT_MS = 20_000
// `system_profiler SPFontsDataType` walks every installed font. On macOS this
// commonly takes longer than the generic probe timeout, especially when users
// have a large Font Book library; keep its one cached scan reliable.
const MAC_FONT_DETECTION_TIMEOUT_MS = 60_000
const DETECTION_ERROR =
  "System fonts could not be detected. The default monospace font is still available."

export interface SystemFontDetectionResult {
  families: string[]
  error: string | null
}

export type SystemFontDetector = () => Promise<SystemFontDetectionResult>
export type SystemFontExec = (command: string, args: string[]) => Promise<{ stdout: string }>

function liveSystemFontExec(command: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout:
          command === "/usr/sbin/system_profiler"
            ? MAC_FONT_DETECTION_TIMEOUT_MS
            : DEFAULT_DETECTION_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve({ stdout: String(stdout) })
      },
    )
  })
}

function normalizedFamilies(values: Iterable<string>): string[] {
  return [
    ...new Set([...values].map((value) => value.trim()).filter((value) => value.length > 0)),
  ].sort((left, right) => left.localeCompare(right))
}

function macFamilies(stdout: string): string[] {
  const parsed: unknown = JSON.parse(stdout)
  const families: string[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const [key, child] of Object.entries(value)) {
      if (key === "family" && typeof child === "string") families.push(child)
      else visit(child)
    }
  }
  visit(parsed)
  return normalizedFamilies(families)
}

function lineFamilies(stdout: string, splitCommas: boolean): string[] {
  const values = splitCommas ? stdout.split(/\r?\n|,/) : stdout.split(/\r?\n/)
  return normalizedFamilies(values)
}

function detected(families: string[]): SystemFontDetectionResult {
  return families.length > 0 ? { families, error: null } : { families: [], error: DETECTION_ERROR }
}

/**
 * Build the system-font scan for one platform. Every subprocess call is an exact
 * executable plus argv tuple; no user value enters a command string.
 */
export function createSystemFontDetector(
  platform: NodeJS.Platform,
  exec: SystemFontExec,
): SystemFontDetector {
  return async () => {
    try {
      if (platform === "darwin") {
        const { stdout } = await exec("/usr/sbin/system_profiler", ["SPFontsDataType", "-json"])
        return detected(macFamilies(stdout))
      }
      if (platform === "linux") {
        const { stdout } = await exec("fc-list", ["--format=%{family}\\n"])
        return detected(lineFamilies(stdout, true))
      }
      if (platform === "win32") {
        const { stdout } = await exec("powershell.exe", [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Add-Type -AssemblyName PresentationCore; [System.Windows.Media.Fonts]::SystemFontFamilies | ForEach-Object { $_.Source }",
        ])
        return detected(lineFamilies(stdout, false))
      }
      return { families: [], error: DETECTION_ERROR }
    } catch {
      return { families: [], error: DETECTION_ERROR }
    }
  }
}

/** Memoize the in-flight/result promise so concurrent callers share one OS scan. */
export function cacheSystemFontDetector(detector: SystemFontDetector): SystemFontDetector {
  let result: Promise<SystemFontDetectionResult> | null = null
  return () => {
    result ??= detector()
    return result
  }
}

export const liveSystemFontDetector = createSystemFontDetector(process.platform, liveSystemFontExec)
