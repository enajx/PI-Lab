import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "vitest"

const css = readFileSync(resolve(__dirname, "selectFolderPrompt.css"), "utf8")

describe("Select experiments folder cue", () => {
  test("glows evenly in and out over the whole button, with nothing moving", () => {
    expect(css).toMatch(/\.analysis-select-folder-glow::before\s*\{[^}]*animation/)
    expect(css).toMatch(/@keyframes analysis-select-folder-glow\s*\{[\s\S]*opacity/)
    expect(css).not.toMatch(/translate|gradient/)
  })

  test("stops the glow when reduced motion is requested", () => {
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.analysis-select-folder-glow::before[\s\S]*animation:\s*none/,
    )
  })
})
