import "@pi-lab/ui/styles/globals.css"
import { RouterProvider } from "@tanstack/react-router"
import { StrictMode, useEffect } from "react"
import { createRoot } from "react-dom/client"
import { initializeInterfaceLanguage } from "./i18n/language"
import { AppProviders } from "./providers/AppProviders"
import { createAppRouter } from "./router"

const rootElement = document.getElementById("root")
if (!rootElement) {
  throw new Error("Renderer root element #root not found")
}

/** Route OS and terminal file-open requests into the already-running window. */
function QuickEditOpenController({ router }: { router: ReturnType<typeof createAppRouter> }) {
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
  }, [router])
  return null
}

void initializeInterfaceLanguage().then(() => {
  const router = createAppRouter()
  createRoot(rootElement).render(
    <StrictMode>
      <AppProviders>
        <QuickEditOpenController router={router} />
        <RouterProvider router={router} />
      </AppProviders>
    </StrictMode>,
  )
})
