/**
 * Shared title-bar chrome for the main-panel route headers. When the left sidebar
 * is COLLAPSED, the macOS traffic lights move out of the (now 56px) sidebar header
 * and into the route's title-bar strip, just right of the rail (see
 * main/window/trafficLights.ts + useTitleBarTrafficLights). A collapsed header then
 * has to (a) clear the lights with extra left padding and (b) stay window-draggable
 * (`app-drag`), with its interactive controls opting back out (`app-no-drag`).
 * Expanded, the lights live on the wide sidebar header and the route header is
 * ordinary, undragged content — so every helper returns nothing when not collapsed,
 * keeping the expanded layout byte-for-byte unchanged.
 */

/**
 * Left padding that clears the title-bar lights when collapsed. The lights sit at
 * x70 and span ~52px (to ~x122); the collapsed rail is 56px, so within the main
 * panel content must start past ~x66 — `pl-20` (80px) lands it at ~x136, mirroring
 * the existing pl-20 lights-clearance convention (sidebar/settings headers).
 */
export const TITLEBAR_LIGHTS_CLEARANCE = "pl-20"

/**
 * Classes a flush route header (one whose left edge meets the main panel, default
 * `px-6`) swaps in when collapsed: drag the strip + clear the lights, keeping the
 * right padding. Expanded, it returns the original `px-6` so nothing changes.
 */
export function titleBarHeaderClass(collapsed: boolean): string {
  return collapsed ? `app-drag ${TITLEBAR_LIGHTS_CLEARANCE} pr-6` : "px-6"
}

/**
 * Classes the lights-clearance adds to a header that is already inset by its parent
 * (e.g. the project view's `p-4`): just drag + extra left padding, no `px` swap.
 * Empty when expanded.
 */
export function titleBarInsetHeaderClass(collapsed: boolean): string {
  return collapsed ? `app-drag ${TITLEBAR_LIGHTS_CLEARANCE}` : ""
}

/**
 * Marks an interactive control inside a collapsed (dragged) header as click-through
 * — `app-no-drag` — so it stays usable / its text stays selectable. Empty when
 * expanded (the header isn't a drag region then).
 */
export function titleBarControlClass(collapsed: boolean): string {
  return collapsed ? "app-no-drag" : ""
}
