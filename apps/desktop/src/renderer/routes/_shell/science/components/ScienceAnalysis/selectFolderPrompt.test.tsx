import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "vitest"

const css = readFileSync(resolve(__dirname, "selectFolderPrompt.css"), "utf8")

describe("Select experiments folder cue", () => {
  test("moves a soft wave across the button face instead of pulsing its edge", () => {
    expect(css).toMatch(/\.analysis-select-folder-wave::before\s*\{[^}]*animation/)
    expect(css).toMatch(/@keyframes analysis-select-folder-wave\s*\{[\s\S]*translateX/)
    expect(css).not.toMatch(/box-shadow/)
  })

  test("stops the wave when reduced motion is requested", () => {
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.analysis-select-folder-wave::before[\s\S]*animation:\s*none/,
    )
  })
})
