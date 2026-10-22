import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { cssBlocks } from "./cssTestUtils"

const stylesheet = readFileSync(new URL("./globals.css", import.meta.url), "utf8")
const gradientKeyframes = cssBlocks(stylesheet, /@keyframes pi-lab-gradient-[a-z-]+\s*\{/)
const organicAnimation = gradientKeyframes.join("\n")

describe("project gradient animation", () => {
  test("uses several transform-only motion equations", () => {
    expect(gradientKeyframes.length).toBeGreaterThanOrEqual(6)
    expect(organicAnimation).not.toMatch(/background|filter|opacity|inset|position/)

    expect(organicAnimation).toMatch(/translate3d/)
    expect(organicAnimation).toMatch(/scale/)
    expect(organicAnimation).toMatch(/rotate/)
    expect(organicAnimation).toMatch(/skew/)
  })

  test("keeps the base field stationary and gives each layer inherited play state", () => {
    const [field] = cssBlocks(stylesheet, /\.project-gradient-field\s*\{/)
    expect(field).toBeDefined()
    for (const declaration of [
      /position:\s*absolute;/,
      /inset:\s*0;/,
      /isolation:\s*isolate;/,
      /pointer-events:\s*none;/,
    ]) {
      expect(field).toMatch(declaration)
    }
    expect(field).not.toMatch(/animation:/)
    const [layer] = cssBlocks(stylesheet, /\.project-gradient-layer\s*\{/)
    expect(layer).toMatch(/animation-play-state:\s*var\(--gradient-play-state,\s*paused\);/)
    expect(layer).toMatch(/will-change:\s*var\(--gradient-will-change,\s*auto\);/)
    expect(stylesheet).toMatch(
      /\.project-gradient-layer-a\s*\{[^}]*animation-duration:\s*var\(--layer-a-duration/,
    )
    expect(stylesheet).toMatch(
      /\.project-gradient-layer-b\s*\{[^}]*animation-duration:\s*var\(--layer-b-duration/,
    )
    expect(stylesheet).toMatch(
      /\.project-gradient-layer-c\s*\{[^}]*animation-duration:\s*var\(--layer-c-duration/,
    )
    expect(
      stylesheet.match(/\.project-gradient-motion-[a-z-]+ \.project-gradient-layer-a/g)?.length,
    ).toBeGreaterThanOrEqual(5)
  })

  test("keeps this diagnostic animation enabled even when macOS Reduce Motion is on", () => {
    const reducedMotionBlocks = cssBlocks(
      stylesheet,
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/,
    )
    expect(reducedMotionBlocks.length).toBeGreaterThan(0)
    expect(reducedMotionBlocks.every((block) => !block.includes(".project-gradient-layer"))).toBe(
      true,
    )
  })
})
