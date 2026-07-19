import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { FirstRunSetup } from "../../setup/FirstRunSetup"

export const Route = createFileRoute("/_shell/setup")({
  component: SetupView,
})

export function SetupView() {
  const navigate = useNavigate()
  return <FirstRunSetup onClose={() => void navigate({ to: "/", replace: true })} />
}
