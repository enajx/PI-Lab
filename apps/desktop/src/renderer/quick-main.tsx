import "@pi-lab/ui/styles/globals.css"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { initializeInterfaceLanguage } from "./i18n/language"
import { applySavedAppearance, ThemeProvider } from "./providers/ThemeProvider"
import { QuickEditor } from "./QuickEditor/QuickEditor"

const root = document.getElementById("root")
if (!root) throw new Error("Quick editor root element is missing")
initializeInterfaceLanguage()
applySavedAppearance()
createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <QuickEditor fullApp={false} />
    </ThemeProvider>
  </StrictMode>,
)
