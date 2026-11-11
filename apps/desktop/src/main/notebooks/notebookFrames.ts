import { session } from "electron"
import { NOTEBOOK_HOST } from "./notebookLaunch"

/**
 * Let a notebook server's page work inside a PI Lab tab, where it is a frame from
 * another site. For responses from a running notebook server on 127.0.0.1 this
 * returns the headers without X-Frame-Options (marimo sends DENY) and with its
 * cookies marked `SameSite=None; Secure` (marimo's login cookie is otherwise not
 * sent from the frame; Chromium accepts Secure cookies on 127.0.0.1). For anything
 * else it returns null (leave the response unchanged).
 */
export function headersAllowingNotebookFrame(
  url: string,
  headers: Record<string, string[]>,
  isNotebookPort: (port: number) => boolean,
): Record<string, string[]> | null {
  if (!URL.canParse(url)) return null
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" || parsed.hostname !== NOTEBOOK_HOST) return null
  if (!isNotebookPort(Number(parsed.port))) return null
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => name.toLowerCase() !== "x-frame-options")
      .map(([name, values]) =>
        name.toLowerCase() === "set-cookie" ? [name, values.map(crossSiteCookie)] : [name, values],
      ),
  )
}

function crossSiteCookie(cookie: string): string {
  const kept = cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !/^(samesite|secure)(=|$)/i.test(part))
  return [...kept, "SameSite=None", "Secure"].join("; ")
}

/** Install the header change on the app's session (once, at startup). */
export function installNotebookFrameHeaders(isNotebookPort: (port: number) => boolean): void {
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: [`http://${NOTEBOOK_HOST}:*/*`] },
    (details, callback) => {
      const responseHeaders = headersAllowingNotebookFrame(
        details.url,
        details.responseHeaders ?? {},
        isNotebookPort,
      )
      callback(responseHeaders ? { responseHeaders } : {})
    },
  )
}
