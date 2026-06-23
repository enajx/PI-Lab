import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

// Renderer (jsdom) component tests: unmount + reset the DOM between tests so
// React Testing Library mounts don't leak across cases (AGENTS.md §14).
afterEach(() => {
  cleanup()
})
