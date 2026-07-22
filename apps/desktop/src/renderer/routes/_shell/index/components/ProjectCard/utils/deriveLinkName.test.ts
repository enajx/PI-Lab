import { describe, expect, test } from "vitest"
import { deriveLinkName } from "./deriveLinkName"

describe("deriveLinkName", () => {
  test("takes the second-level domain from an Overleaf-style URL", () => {
    expect(deriveLinkName("https://www.overleaf.com/project/abc123")).toBe("overleaf")
  })

  test("derives from a bare host with a path and no www", () => {
    expect(deriveLinkName("github.com/a/b")).toBe("github")
  })

  test("works without a scheme", () => {
    expect(deriveLinkName("www.overleaf.com/x/y")).toBe("overleaf")
  })

  test("strips a leading www even on the plain domain", () => {
    expect(deriveLinkName("https://www.example.com")).toBe("example")
    expect(deriveLinkName("https://example.com")).toBe("example")
  })

  test("uses the naive second-to-last label for multi-part TLDs", () => {
    // No public-suffix list on purpose — `co.uk` collapses to `co`.
    expect(deriveLinkName("https://sub.example.co.uk/path")).toBe("co")
  })

  test("returns the single label when the host has no dots", () => {
    expect(deriveLinkName("http://localhost:3000/x")).toBe("localhost")
  })

  test("falls back to the raw text for an unparseable url", () => {
    expect(deriveLinkName("not a url")).toBe("not a url")
  })

  test("returns empty for an empty/whitespace input", () => {
    expect(deriveLinkName("")).toBe("")
    expect(deriveLinkName("   ")).toBe("")
  })
})
