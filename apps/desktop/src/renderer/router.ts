import { createHashHistory, createRouter } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"

/**
 * Renderer router. Uses **hash** history on purpose:
 * the packaged app loads the renderer over `file://…/index.html`, where a
 * browser-history router would see the full filesystem path as the location and
 * never match `/`. Hash history keeps the route in the URL fragment, independent
 * of the file path, and leaves `window.location.search` (the terminal test seam) untouched.
 */
export function createAppRouter() {
  return createRouter({
    routeTree,
    history: createHashHistory(),
    defaultPreload: "intent",
  })
}

/** Register the router instance type for fully-typed links/navigation. */
declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
