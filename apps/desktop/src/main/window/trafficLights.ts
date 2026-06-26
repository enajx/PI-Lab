/**
 * macOS traffic-light positioning (darwin-only). The window is created with
 * `titleBarStyle: "hiddenInset"` and the lights inset at {@link DEFAULT_TRAFFIC_LIGHT_POSITION}
 * so they sit on the sidebar's own header (mainWindow.ts). When the left sidebar
 * collapses to its 56px icon rail, that header is too narrow to hold the lights
 * without overhanging the page, so the renderer asks us to move them *into the
 * title-bar strip above the main panel* — just to the right of the rail
 * ({@link TITLEBAR_TRAFFIC_LIGHT_POSITION}). Expanding (or any sidebar-less route)
 * moves them back to the default.
 *
 * `setWindowButtonPosition` is macOS-only, so {@link applyTrafficLightInset} is a
 * no-op off darwin. The position math is a pure function so it stays unit-testable
 * without a real BrowserWindow.
 */

/** A traffic-light inset (window coordinates from the top-left). */
export interface TrafficLightPosition {
  x: number
  y: number
}

/**
 * Default inset — lights on the sidebar header. Mirrors the explicit
 * `trafficLightPosition` passed to the BrowserWindow constructor (mainWindow.ts);
 * we re-set this exact value (never `null`, which would reset to the OS default,
 * not ours) when moving the lights back.
 */
export const DEFAULT_TRAFFIC_LIGHT_POSITION: TrafficLightPosition = { x: 16, y: 18 }

/**
 * Title-bar inset — lights just right of the 56px collapsed rail, so they land in
 * the title-bar strip above the main panel. `y` matches the default so the lights
 * never jump vertically.
 */
export const TITLEBAR_TRAFFIC_LIGHT_POSITION: TrafficLightPosition = { x: 70, y: 18 }

/** The inset for a given placement: the title-bar strip when in it, else the sidebar header. */
export function trafficLightPositionFor(inTitleBar: boolean): TrafficLightPosition {
  return inTitleBar ? TITLEBAR_TRAFFIC_LIGHT_POSITION : DEFAULT_TRAFFIC_LIGHT_POSITION
}

/** The slice of a BrowserWindow we touch — narrowed so the apply logic is testable. */
export interface TrafficLightWindow {
  setWindowButtonPosition(position: TrafficLightPosition | null): void
}

/**
 * Move `win`'s traffic lights to the title-bar or default inset. Returns whether
 * it was applied: a no-op (returns `false`) off darwin — `setWindowButtonPosition`
 * is macOS-only — or when there is no window. `platform` is injectable so the
 * darwin guard is unit-testable on any host.
 */
export function applyTrafficLightInset(
  win: TrafficLightWindow | null,
  inTitleBar: boolean,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "darwin") return false
  if (!win) return false
  win.setWindowButtonPosition(trafficLightPositionFor(inTitleBar))
  return true
}
