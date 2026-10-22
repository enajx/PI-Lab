import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { cssBlocks } from "./cssTestUtils"

const stylesheet = readFileSync(new URL("./globals.css", import.meta.url), "utf8")

describe("control animation treatments", () => {
  test("keeps the running workflow cue on the compositor", () => {
    expect(stylesheet).toMatch(/\.pi-lab-workflow-sweep::before\s*\{[^}]*animation/)
    expect(stylesheet).toMatch(/@keyframes pi-lab-workflow-sweep\s*\{[\s\S]*translateX/)
    expect(stylesheet).not.toContain("pi-lab-workflow-snake")
    expect(stylesheet).not.toContain("-webkit-mask-composite")
  })

  test("uses distinct Steam, Halo, and Shimmer motion", () => {
    expect(stylesheet).toMatch(/@keyframes pi-lab-control-steam/)
    expect(stylesheet).toMatch(/@keyframes pi-lab-control-halo/)
    expect(stylesheet).toMatch(/@keyframes pi-lab-control-shimmer/)
    expect(stylesheet).toMatch(
      /\.control-animation\[data-active="false"\] \.control-animation-effect\s*\{[^}]*display:\s*none/,
    )
  })

  test("removes all treatment animation when reduced motion is requested", () => {
    const reducedMotion = cssBlocks(
      stylesheet,
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/,
    ).join("\n")
    expect(reducedMotion).toContain(".control-animation-steam")
    expect(reducedMotion).toContain(".control-animation-halo")
    expect(reducedMotion).toContain(".control-animation-shimmer::after")
    expect(reducedMotion).toContain("animation: none")
  })
})
