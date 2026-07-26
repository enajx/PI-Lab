/** The app view to restore when Settings closes during this renderer session. */
interface SettingsReturnRoute {
  pathname: string
  search: unknown
}

let returnRoute: SettingsReturnRoute | null = null

export function rememberSettingsReturnRoute(route: SettingsReturnRoute): void {
  if (route.pathname !== "/settings") returnRoute = route
}

export function readSettingsReturnRoute(): SettingsReturnRoute {
  return returnRoute ?? { pathname: "/", search: {} }
}

/** Capture the current hash-router location before a plain settings deep link. */
export function rememberCurrentSettingsReturnRoute(): void {
  if (typeof window === "undefined") return
  const fragment = window.location.hash.replace(/^#/, "") || "/"
  const url = new URL(fragment, "https://pi-lab.local")
  rememberSettingsReturnRoute({
    pathname: url.pathname,
    search: Object.fromEntries(url.searchParams),
  })
}
