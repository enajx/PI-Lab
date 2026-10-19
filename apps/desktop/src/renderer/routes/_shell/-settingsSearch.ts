import { stripOuterQuery } from "../../QuickEditor/routeTarget"

/** Settings search validation has no dependency on the deferred view registry. */
const SETTINGS_SECTION_IDS = [
  "general",
  "appearance",
  "editor",
  "quick-editor",
  "agents",
  "notifications",
  "caffeine",
  "project-template",
  "library",
  "project-view",
  "sections",
  "experiments",
  "shortcuts",
  "experimental",
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number]

export interface SettingsSearch {
  section?: SettingsSectionId
  advanced?: "editor-typography"
  returnTarget?: string
}

/** Keep invalid or unrelated URL values out of the typed Settings search state. */
export function validateSettingsSearch(search: Record<string, unknown>): SettingsSearch {
  return {
    section: SETTINGS_SECTION_IDS.find((id) => id === search.section),
    advanced: search.advanced === "editor-typography" ? search.advanced : undefined,
    returnTarget:
      typeof search.returnTarget === "string" && search.returnTarget
        ? stripOuterQuery(search.returnTarget)
        : undefined,
  }
}
