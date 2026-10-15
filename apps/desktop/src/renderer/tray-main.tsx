import "@pi-lab/ui/styles/globals.css"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { TrayPopover } from "./TrayPopover/TrayPopover"

const root = document.getElementById("root")
if (!root) throw new Error("Tray popover root element is missing")
createRoot(root).render(
  <StrictMode>
    <TrayPopover />
  </StrictMode>,
)
