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
