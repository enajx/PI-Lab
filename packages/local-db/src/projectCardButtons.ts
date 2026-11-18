/**
 * Browser-safe Projects Dashboard card button choices (no database or Node
 * imports, so the renderer can read the canonical list and default).
 */

/** The card action buttons the user can show or hide, in card order. */
export const PROJECT_CARD_BUTTONS = ["tasks", "analysis", "latex", "auto-research"] as const

export type ProjectCardButton = (typeof PROJECT_CARD_BUTTONS)[number]

/**
 * Shown buttons for an install that never changed the setting
 * (`settings.editor.projectCardButtons` is absent): Auto-research is hidden.
 */
export const DEFAULT_PROJECT_CARD_BUTTONS: readonly ProjectCardButton[] = [
  "tasks",
  "analysis",
  "latex",
]

/** The shown buttons: the saved list, or the default when it was never saved. */
export function shownProjectCardButtons(
  saved: readonly ProjectCardButton[] | null | undefined,
): readonly ProjectCardButton[] {
  return saved ?? DEFAULT_PROJECT_CARD_BUTTONS
}
