/**
 * Carry a card-triggered "Auto-research" launch intent from a Dashboard project
 * card to the project workspace that opens next.
 *
 * The card navigates **immediately** and only records the intent here; the
 * project view picks it up on mount and runs the launch itself, attaching the
 * returned session to its central panel (a failed launch surfaces there). This
 * keeps opening the project independent of the (potentially long) launch RPC, so
 * the view never gets stuck on "Opening project…". Mirrors the sibling
 * `-pendingTaskSession` idiom: deliberately renderer-local, carrying only the
 * intent across the immediate route transition.
 *
 * (Fetch experiments and Project summary are no longer launch intents — they run
 * as in-place background workflow controls, so only auto-research remains.)
 */
export type PendingLaunch = { kind: "auto-research" }

const pendingByProject = new Map<string, PendingLaunch>()

/** Record the launch a project card just triggered, to run on the project view. */
export function setPendingLaunch(projectId: string, launch: PendingLaunch): void {
  pendingByProject.set(projectId, launch)
}

/** Read without consuming so React StrictMode's repeated initial render is safe. */
export function readPendingLaunch(projectId: string): PendingLaunch | null {
  return pendingByProject.get(projectId) ?? null
}

/** Clear after the project view has claimed the pending launch. */
export function clearPendingLaunch(projectId: string): void {
  pendingByProject.delete(projectId)
}
