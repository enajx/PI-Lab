import { isRedirect } from "@tanstack/react-router"
import { beforeEach, describe, expect, test } from "vitest"
import { Route as AnalysisRoute } from "./analysis"
import { Route as ClusterRoute } from "./cluster"

/**
 * Guards for the optional-section routes (Cluster / Analysis). Their `beforeLoad`
 * reads the section preference and throws a `redirect({ to: "/" })` when the
 * section is hidden, so a bookmarked/direct navigation can't reach a surface the
 * user turned off in Settings → Sections. Exercised through the real Route
 * definition's `beforeLoad`, which is the guard's public seam.
 */

type BeforeLoad = () => unknown
const clusterGuard = ClusterRoute.options.beforeLoad as BeforeLoad
const analysisGuard = AnalysisRoute.options.beforeLoad as BeforeLoad

beforeEach(() => {
  window.localStorage.clear()
})

describe("optional-section route guards", () => {
  test("Cluster route redirects home when its section is hidden", () => {
    window.localStorage.setItem("pi-lab.sections.showCluster", "false")
    let thrown: unknown
    try {
      clusterGuard()
    } catch (error) {
      thrown = error
    }
    expect(isRedirect(thrown)).toBe(true)
    expect((thrown as { options?: { to?: string } }).options?.to).toBe("/")
  })

  test("Cluster route loads normally when its section is shown (default)", () => {
    expect(() => clusterGuard()).not.toThrow()
  })

  test("Analysis route redirects home when its section is hidden", () => {
    window.localStorage.setItem("pi-lab.sections.showAnalysis", "false")
    let thrown: unknown
    try {
      analysisGuard()
    } catch (error) {
      thrown = error
    }
    expect(isRedirect(thrown)).toBe(true)
    expect((thrown as { options?: { to?: string } }).options?.to).toBe("/")
  })

  test("Analysis route loads normally when its section is shown (default)", () => {
    expect(() => analysisGuard()).not.toThrow()
  })
})
