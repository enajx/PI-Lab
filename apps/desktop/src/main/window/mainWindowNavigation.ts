/** File navigation stays on app entries; development navigation stays on its HTTP origin. */
export function isTrustedNavigation(navigationUrl: string, entryUrls: readonly string[]): boolean {
  const target = new URL(navigationUrl)
  return entryUrls.some((entryUrl) => {
    const entry = new URL(entryUrl)
    if (entry.protocol === "http:" || entry.protocol === "https:") {
      return target.origin === entry.origin
    }
    return (
      target.protocol === "file:" &&
      entry.protocol === "file:" &&
      target.host === entry.host &&
      target.pathname === entry.pathname
    )
  })
}

/**
 * The address to open in the user's browser when the page asks for a new
 * window (a `target="_blank"` link), or null to only block it. Only `https:`
 * addresses go to the browser; everything else stays blocked.
 */
export function browserUrlForNewWindow(url: string): string | null {
  if (!URL.canParse(url)) return null
  return new URL(url).protocol === "https:" ? url : null
}
