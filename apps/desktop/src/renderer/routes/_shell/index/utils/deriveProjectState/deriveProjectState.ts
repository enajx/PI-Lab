/**
 * The dashboard card's status, color-coded by the glowy-edge spec in
 * md/02-ux-and-design.md ("Dashboard & project cards"):
 *
 *   - "attention" → needs a human (red glow in the full design).
 *   - "active"    → things are going on (white glow): the project has open
 *                   workspaces/sessions, or uncommitted work in its tree.
 *   - "idle"      → nothing happening (no glow).
 *
 * v1 derives state purely from data the dashboard already has on hand — the
 * project's workspace count and its working-tree change count — plus an explicit
 * `attentionCount` channel the later workflow/automation layer can raise to flag
 * a project that needs the researcher. No "unread" concept exists yet, so that
 * channel stays 0 until something sets it; the field is part of the input now so
 * the function is complete and the enum is exhaustive from day one.
 */
export type ProjectState = "idle" | "active" | "attention"

export interface ProjectStateInput {
  /** Open workspaces/sessions in the project. */
  sessionCount: number
  /** Changed paths in the project's working tree (staged + unstaged + untracked). */
  changeCount: number
  /** Explicit "needs a human" signals (raised by workflows later; 0 for now). */
  attentionCount: number
}

/**
 * Map a project's activity counts to a card state. Pure, **total** (never throws
 * for any finite or non-finite numeric input), and **deterministic** (same input
 * ⇒ same output, no clock/randomness). Negatives, NaN, and Infinity are treated
 * as "not a positive count" via `> 0`, so a garbage input can only ever fall
 * through to a lower-priority state — never out of the enum. Priority is
 * attention > active > idle.
 *
 * These invariants are covered by property tests (totality, enum membership,
 * determinism, and the priority ordering).
 */
export function deriveProjectState({
  sessionCount,
  changeCount,
  attentionCount,
}: ProjectStateInput): ProjectState {
  if (attentionCount > 0) return "attention"
  if (sessionCount > 0 || changeCount > 0) return "active"
  return "idle"
}
