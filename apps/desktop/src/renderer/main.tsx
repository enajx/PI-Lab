import "@pi-lab/ui/styles/globals.css"
import { RouterProvider } from "@tanstack/react-router"
import { StrictMode } from "react"
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

createRoot(rootElement).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
)
