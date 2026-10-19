import "@pi-lab/ui/styles/globals.css"
import { RouterProvider } from "@tanstack/react-router"
import { StrictMode, useEffect } from "react"
import { createRoot } from "react-dom/client"
import { initializeInterfaceLanguage } from "./i18n/language"
import { AppProviders } from "./providers/AppProviders"
import { createAppRouter } from "./router"

const rootElement = document.getElementById("root")
initializeInterfaceLanguage()
if (!rootElement) {
  throw new Error("Renderer root element #root not found")
}

// The router is created once at module scope; providers wrap it so Query/tRPC and
// theme context are available to every route (md/engineering/architecture.md (renderer)).
const router = createAppRouter()

/** Route OS and terminal file-open requests into the already-running window. */
function QuickEditOpenController() {
  useEffect(() => {
    const bridge = window.piLab?.quickEdit
    if (!bridge) return
    const open = (target: { id: string }): void => {
      if (window.location.hash.startsWith("#/quick-edit")) return
      void bridge
        .resolveRoute(target.id)
        .then((route) => router.navigate({ href: route }))
        .catch((error: unknown) => console.error("Could not route quick file:", error))
    }
    const unsubscribe = bridge.subscribeOpen(open)
    const unsubscribeRoute = bridge.subscribeRoute((route) => {
      if (window.location.hash.startsWith("#/quick-edit")) return
      void router.navigate({ href: route })
    })
    void bridge.routesReady().then((pendingRoute) => {
      if (pendingRoute) {
        void router.navigate({ href: pendingRoute })
        return
      }
      void bridge.current().then((target) => {
        if (
          target &&
          !window.location.hash.startsWith("#/projects/") &&
          !window.location.hash.startsWith("#/settings")
        ) {
          open(target)
        }
      })
    })
    return () => {
      unsubscribe()
      unsubscribeRoute()
    }
  }, [])
  return null
}

createRoot(rootElement).render(
  <StrictMode>
    <AppProviders>
      <QuickEditOpenController />
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
)
