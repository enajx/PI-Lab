/** Shared draggable main-panel headers, with extra traffic-light clearance when collapsed. */
export const TITLEBAR_LIGHTS_CLEARANCE = "pl-20"

/** Keep the flush header draggable in either sidebar layout. */
export function titleBarHeaderClass(collapsed: boolean): string {
  return collapsed ? `app-drag ${TITLEBAR_LIGHTS_CLEARANCE} pr-6` : "app-drag px-6"
}

/** Keep inset headers draggable while clearing the collapsed traffic lights. */
export function titleBarInsetHeaderClass(collapsed: boolean): string {
  return collapsed ? `app-drag ${TITLEBAR_LIGHTS_CLEARANCE}` : "app-drag"
}

/** Exclude interactive header controls from the window drag region. */
export function titleBarControlClass(_collapsed: boolean): string {
  return "app-no-drag"
}
