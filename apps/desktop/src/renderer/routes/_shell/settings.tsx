import { createFileRoute } from "@tanstack/react-router"
import { validateSettingsSearch } from "./-settingsSearch"
import { SettingsView } from "./settings/-SettingsView"

export const Route = createFileRoute("/_shell/settings")({
  validateSearch: validateSettingsSearch,
  component: SettingsView,
})
