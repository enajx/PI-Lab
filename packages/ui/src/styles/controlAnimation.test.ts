import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

const stylesheet = readFileSync(new URL("./globals.css", import.meta.url), "utf8")

describe("control animation treatments", () => {
  test("uses distinct Steam, Halo, and Shimmer motion", () => {
    expect(stylesheet).toMatch(/@keyframes pi-lab-control-steam/)
    expect(stylesheet).toMatch(/@keyframes pi-lab-control-halo/)
    expect(stylesheet).toMatch(/@keyframes pi-lab-control-shimmer/)
    expect(stylesheet).toMatch(
      /\.control-animation\[data-active="false"\] \.control-animation-effect\s*\{[^}]*display:\s*none/,
    )
  })

  test("removes all treatment animation when reduced motion is requested", () => {
    const reducedMotion = stylesheet.slice(
      stylesheet.indexOf("@media (prefers-reduced-motion: reduce)"),
      stylesheet.indexOf("/* No-thumbnail project-card"),
    )
    expect(reducedMotion).toContain(".control-animation-steam")
    expect(reducedMotion).toContain(".control-animation-halo")
    expect(reducedMotion).toContain(".control-animation-shimmer::after")
    expect(reducedMotion).toContain("animation: none")
  })
})
