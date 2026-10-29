import "@pi-lab/ui/styles/globals.css"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { initializeInterfaceLanguage } from "./i18n/language"
import { applySavedAppearance, ThemeProvider } from "./providers/ThemeProvider"
import { QuickEditor } from "./QuickEditor/QuickEditor"
import { installCloseTabResponder } from "./shortcuts/closeTab"

const root = document.getElementById("root")
if (!root) throw new Error("Quick editor root element is missing")
applySavedAppearance()
// The standalone quick editor has no file tabs: Cmd+W always moves the app to the background.
const closeTabBridge = window.piLab?.closeTab
if (closeTabBridge) installCloseTabResponder(closeTabBridge)
void initializeInterfaceLanguage().then(() => {
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider>
        <QuickEditor fullApp={false} />
      </ThemeProvider>
    </StrictMode>,
  )
})
