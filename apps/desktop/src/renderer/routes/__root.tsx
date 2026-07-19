import { createRootRoute, Outlet } from "@tanstack/react-router"

/**
 * Root route (TanStack Router, file-based). No auth guard, no loaders — the app
 * opens straight to the shell (md/engineering/architecture.md (renderer)). Everything visual lives in child
 * routes; this is just the render anchor + a place to hang app-wide error/404
 * UI as later phases add them.
 */
export const Route = createRootRoute({
  component: RootLayout,
})

function RootLayout() {
  return <Outlet />
}
