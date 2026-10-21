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
