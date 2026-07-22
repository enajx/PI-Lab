import { type RenderOptions, render as rtlRender } from "@testing-library/react"
import { type ReactElement, StrictMode } from "react"

// Re-export the rest of Testing Library unchanged (screen, fireEvent, waitFor, …).
export * from "@testing-library/react"

/**
 * A StrictMode-wrapped `render` for renderer tests.
 *
 * The dev build the user actually runs mounts the app inside `<StrictMode>`
 * (`renderer/main.tsx`), which double-invokes effects — the production build the
 * e2e suite drives does not. A StrictMode-unsafe mount effect (e.g. a "fire once"
 * guard whose async result is dropped by its cleanup) therefore passes every
 * production-build test yet hangs the dev app — exactly the "Opening project…"
 * regression. Rendering route/surface tests through this helper reproduces the
 * double-invoke so that whole class of dev-only bug fails a test instead of the
 * user. Prefer this over Testing Library's raw `render` for anything that mounts
 * a route/workspace/data-loading surface.
 */
export function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(<StrictMode>{ui}</StrictMode>, options)
}
