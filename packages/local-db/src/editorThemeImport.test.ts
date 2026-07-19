import { describe, expect, test } from "vitest"
import { parseVSCodeColorTheme } from "./editorThemeImport"

describe("parseVSCodeColorTheme", () => {
  test("sanitizes supported colors and token rules into path-free persisted data", () => {
    const result = parseVSCodeColorTheme(
      JSON.stringify({
        name: "Ocean Lab",
        type: "dark",
        colors: {
          "editor.background": "#102030",
          "editor.foreground": "#ddeeff",
          "editorCursor.foreground": "#abcdef",
          "terminal.background": "#000000",
          "editor.selectionBackground": "url(javascript:alert(1))",
        },
        tokenColors: [
          {
            scope: ["comment", "punctuation.definition.comment"],
            settings: { foreground: "#778899", fontStyle: "italic bold blink" },
          },
          { scope: "string", settings: { foreground: "red" } },
        ],
      }),
      "fallback.json",
    )

    expect(result).toMatchObject({
      name: "Ocean Lab",
      mode: "dark",
      colors: {
        background: "#102030",
        foreground: "#ddeeff",
        caret: "#abcdef",
      },
      tokenColors: [
        {
          scopes: ["comment", "punctuation.definition.comment"],
          foreground: "#778899",
          fontStyle: "italic bold",
        },
      ],
    })
    expect(JSON.stringify(result)).not.toContain("fallback.json")
    expect(result.id).toMatch(/^custom:ocean-lab:/)
  })

  test("uses the filename as a safe name and infers mode from background luminance", () => {
    const result = parseVSCodeColorTheme(
      JSON.stringify({
        colors: {
          "editor.background": "#fafafa",
          "editor.foreground": "#222",
        },
        tokenColors: [],
      }),
      "Paper Color Theme.json",
    )
    expect(result.name).toBe("Paper Color Theme")
    expect(result.mode).toBe("light")
  })

  test("rejects malformed, inherited, or structurally unsupported themes visibly", () => {
    expect(() => parseVSCodeColorTheme("{", "bad.json")).toThrow("valid JSON")
    expect(() =>
      parseVSCodeColorTheme(
        JSON.stringify({ include: "./base.json", colors: { "editor.background": "#000" } }),
        "included.json",
      ),
    ).toThrow("inheritance")
    expect(() => parseVSCodeColorTheme(JSON.stringify({ colors: {} }), "empty.json")).toThrow(
      "editor.background",
    )
  })
})
