import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

const stylesheet = readFileSync(new URL("./globals.css", import.meta.url), "utf8")
const organicAnimation = stylesheet.slice(
  stylesheet.indexOf("@keyframes pi-lab-gradient-meander"),
  stylesheet.indexOf("/* Diagnostic build:"),
)

function mediaBlocks(css: string, query: string): string[] {
  const blocks: string[] = []
  let searchFrom = 0
  while (searchFrom < css.length) {
    const header = css.indexOf(`@media ${query}`, searchFrom)
    if (header === -1) break
    const openingBrace = css.indexOf("{", header)
    let depth = 0
    let closingBrace = openingBrace
    for (; closingBrace < css.length; closingBrace += 1) {
      if (css[closingBrace] === "{") depth += 1
      if (css[closingBrace] === "}") depth -= 1
      if (depth === 0) break
    }
    blocks.push(css.slice(header, closingBrace + 1))
    searchFrom = closingBrace + 1
  }
  return blocks
}

describe("project gradient animation", () => {
  test("uses several transform-only motion equations", () => {
    expect(organicAnimation.match(/@keyframes pi-lab-gradient-/g)?.length).toBeGreaterThanOrEqual(6)
    expect(organicAnimation).not.toMatch(/background|filter|opacity|inset|position/)

    expect(organicAnimation).toMatch(/translate3d/)
    expect(organicAnimation).toMatch(/scale/)
    expect(organicAnimation).toMatch(/rotate/)
    expect(organicAnimation).toMatch(/skew/)
  })

  test("keeps the base field stationary and gives each layer inherited play state", () => {
    expect(stylesheet).toMatch(
      /\.project-gradient-field\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*isolation:\s*isolate;[^}]*pointer-events:\s*none;/,
    )
    expect(stylesheet).not.toMatch(/\.project-gradient-field\s*\{[^}]*animation:/)
    expect(stylesheet).toMatch(
      /\.project-gradient-layer\s*\{[\s\S]*?animation-play-state:\s*var\(--gradient-play-state,\s*paused\);[\s\S]*?will-change:\s*var\(--gradient-will-change,\s*auto\);/,
    )
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
    const reducedMotionBlocks = mediaBlocks(stylesheet, "(prefers-reduced-motion: reduce)")
    expect(reducedMotionBlocks.length).toBeGreaterThan(0)
    expect(reducedMotionBlocks.every((block) => !block.includes(".project-gradient-layer"))).toBe(
      true,
    )
  })
})
