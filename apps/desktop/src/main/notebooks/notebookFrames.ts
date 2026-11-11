import { session } from "electron"
import { NOTEBOOK_HOST } from "./notebookLaunch"

/** The frame tree part a request decision needs (Electron's WebFrameMain has this shape). */
export interface RequestFrame {
  url: string
  parent: RequestFrame | null
}

/** A request to a running notebook server: "allowed" from its tab's frame, else "blocked". */
export type NotebookRequestAccess = "not-notebook" | "allowed" | "blocked"

/**
 * Decide a request to a notebook server. Only the notebook tab's frame may reach
 * it: a frame directly in PI Lab's page whose page comes from that same server (or
 * a still-empty frame loading it for the first time), and frames inside it. HTML
 * reports and other frames in the same window are blocked, so they cannot use the
 * notebook's login cookie or reach its kernels. Requests to anything other than a
 * running notebook server are "not-notebook".
 */
export function notebookRequestAccess(
  request: { url: string; resourceType: string },
  frame: RequestFrame | null,
  isNotebookPort: (port: number) => boolean,
  isAppPage: (url: string) => boolean,
): NotebookRequestAccess {
  if (!URL.canParse(request.url)) return "not-notebook"
  const target = new URL(request.url)
  if (target.protocol !== "http:" && target.protocol !== "ws:") return "not-notebook"
  if (target.hostname !== NOTEBOOK_HOST || !isNotebookPort(Number(target.port))) {
    return "not-notebook"
  }
  if (!frame?.parent) return "blocked"
  // The frame of this chain that sits directly in PI Lab's page.
  let tab = frame
  while (tab.parent?.parent) tab = tab.parent
  if (!tab.parent || !isAppPage(tab.parent.url)) return "blocked"
  if (URL.canParse(tab.url)) {
    const page = new URL(tab.url)
    if (page.protocol === "http:" && page.host === target.host) return "allowed"
  }
  const firstLoad = tab.url === "" || tab.url === "about:blank"
  return request.resourceType === "subFrame" && frame === tab && firstLoad ? "allowed" : "blocked"
}

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

/**
 * Install on the app's session (once, at startup): block requests to notebook
 * servers from anything but the notebook tab's frame, and change the headers only
 * for that frame (see {@link notebookRequestAccess}). `isAppPage` tells PI Lab's
 * own page (the packaged file:// page or the dev server) by its URL.
 */
export function installNotebookFrameHeaders(
  isNotebookPort: (port: number) => boolean,
  isAppPage: (url: string) => boolean,
): void {
  const urls = [`http://${NOTEBOOK_HOST}:*/*`, `ws://${NOTEBOOK_HOST}:*/*`]
  const accessOf = (details: {
    url: string
    resourceType: string
    frame?: RequestFrame | null
  }): NotebookRequestAccess =>
    notebookRequestAccess(details, details.frame ?? null, isNotebookPort, isAppPage)
  session.defaultSession.webRequest.onBeforeRequest({ urls }, (details, callback) => {
    const blocked = accessOf(details) === "blocked"
    if (blocked) console.warn(`[pi-lab] blocked a request to a notebook server: ${details.url}`)
    callback({ cancel: blocked })
  })
  session.defaultSession.webRequest.onHeadersReceived({ urls }, (details, callback) => {
    const responseHeaders =
      accessOf(details) === "allowed"
        ? headersAllowingNotebookFrame(details.url, details.responseHeaders ?? {}, isNotebookPort)
        : null
    callback(responseHeaders ? { responseHeaders } : {})
  })
}
