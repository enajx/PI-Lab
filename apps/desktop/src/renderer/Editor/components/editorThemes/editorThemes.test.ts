import { EditorState } from "@codemirror/state"
import { describe, expect, test } from "vitest"
import {
  allEditorThemes,
  defaultEditorThemeId,
  EDITOR_THEMES,
  editorThemeExtension,
  shownEditorThemeId,
} from "./editorThemes"

/** An app theme with Theme default: the editor keeps its own theme. */
const PLAIN = { themeId: "default", accentId: "default" }

describe("editorThemes registry", () => {
  test("offers several high-quality built-ins beyond the original eight", () => {
    expect(EDITOR_THEMES.length).toBeGreaterThanOrEqual(12)
    expect(EDITOR_THEMES.map((theme) => theme.id)).toEqual(
      expect.arrayContaining(["dracula", "monokai", "github-dark", "catppuccin-mocha"]),
    )
  })

  test("every label ends with the suffix matching its mode", () => {
    for (const theme of EDITOR_THEMES) {
      expect(theme.label.endsWith(theme.mode === "light" ? "(Light)" : "(Dark)")).toBe(true)
    }
  })

  test("offers the same number of built-in Light and Dark themes", () => {
    const light = EDITOR_THEMES.filter((theme) => theme.mode === "light")
    const dark = EDITOR_THEMES.filter((theme) => theme.mode === "dark")
    expect(light).toHaveLength(dark.length)
    expect(light.map((theme) => theme.id)).toContain("one-light")
  })

  test("ids are unique and non-empty and labels are non-empty", () => {
    const ids = EDITOR_THEMES.map((theme) => theme.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const theme of EDITOR_THEMES) {
      expect(theme.id.length).toBeGreaterThan(0)
      expect(theme.label.length).toBeGreaterThan(0)
    }
  })

  test("the default theme is GitHub, Light or Dark following the app appearance", () => {
    expect(defaultEditorThemeId("light")).toBe("github-light")
    expect(defaultEditorThemeId("dark")).toBe("github-dark")
    for (const mode of ["light", "dark"] as const) {
      const fallback = EDITOR_THEMES.find((theme) => theme.id === defaultEditorThemeId(mode))
      expect(fallback?.mode).toBe(mode)
    }
  })

  test("every theme extension builds into a valid EditorState", () => {
    // EditorState.create throws on an invalid extension, so a clean build proves
    // each entry is a usable CodeMirror Extension.
    for (const theme of EDITOR_THEMES) {
      expect(() =>
        EditorState.create({ doc: "x = 1", extensions: [theme.extension] }),
      ).not.toThrow()
    }
  })
})

describe("editorThemeExtension", () => {
  test("resolves a known id to its registered extension", () => {
    const known = EDITOR_THEMES.find((theme) => theme.id === "one-dark")
    expect(known).toBeDefined()
    expect(editorThemeExtension("one-dark", [], "light", PLAIN)).toBe(known?.extension)
    // An explicit choice is kept, even the old default palette.
    const solarized = EDITOR_THEMES.find((theme) => theme.id === "solarized-light")
    expect(editorThemeExtension("solarized-light", [], "dark", PLAIN)).toBe(solarized?.extension)
  })

  test("resolves undefined/empty/unknown/default ids to GitHub for the app appearance", () => {
    for (const mode of ["light", "dark"] as const) {
      const fallback = EDITOR_THEMES.find((theme) => theme.id === `github-${mode}`)?.extension
      expect(fallback).toBeDefined()
      expect(editorThemeExtension(undefined, [], mode, PLAIN)).toBe(fallback)
      expect(editorThemeExtension("", [], mode, PLAIN)).toBe(fallback)
      expect(editorThemeExtension("not-a-real-theme", [], mode, PLAIN)).toBe(fallback)
      // "default" is the stored value when the user never picked a theme.
      expect(editorThemeExtension("default", [], mode, PLAIN)).toBe(fallback)
    }
  })

  test("never throws and never returns an unstyled buffer", () => {
    for (const id of [undefined, "", "default", "not-a-real-theme", "solarized-light"]) {
      expect(() => editorThemeExtension(id, [], "light", PLAIN)).not.toThrow()
      expect(editorThemeExtension(id, [], "light", PLAIN)).not.toEqual([])
    }
  })

  test("converts imported VS Code scopes into a valid selectable CodeMirror theme", () => {
    const custom = {
      id: "custom:ocean:abc",
      name: "Ocean",
      mode: "dark" as const,
      colors: { background: "#102030", foreground: "#ddeeff" },
      tokenColors: [
        { scopes: ["comment"], foreground: "#778899", fontStyle: "italic" },
        { scopes: ["entity.name.function"], foreground: "#66ccff" },
        { scopes: ["unsupported.scope"], foreground: "#ffffff" },
      ],
    }
    const themes = allEditorThemes([custom])
    expect(themes.at(-1)).toMatchObject({
      id: custom.id,
      label: "Ocean (Dark)",
      mode: "dark",
      custom: true,
    })
    expect(() =>
      EditorState.create({
        doc: "def run(): pass",
        extensions: [editorThemeExtension(custom.id, [custom], "dark", PLAIN)],
      }),
    ).not.toThrow()
  })

  test("a chosen accent colors the editor unless an editor theme was picked", () => {
    for (const mode of ["light", "dark"] as const) {
      const github = EDITOR_THEMES.find((theme) => theme.id === `github-${mode}`)?.extension
      const pink = { themeId: "nord", accentId: "neon-pink" }
      const accent = editorThemeExtension("default", [], mode, pink)
      expect(accent).not.toBe(github)
      expect(editorThemeExtension(undefined, [], mode, pink)).toBe(accent)
      expect(() => EditorState.create({ doc: "x = 1", extensions: [accent] })).not.toThrow()
      const custom = editorThemeExtension("default", [], mode, {
        themeId: "default",
        accentId: "#ff00aa",
      })
      expect(custom).not.toBe(github)
      // Theme default keeps today's editor colors.
      expect(
        editorThemeExtension("default", [], mode, { themeId: "nord", accentId: "default" }),
      ).toBe(github)
    }
    const monokai = EDITOR_THEMES.find((theme) => theme.id === "monokai")?.extension
    expect(
      editorThemeExtension("monokai", [], "dark", { themeId: "nord", accentId: "neon-pink" }),
    ).toBe(monokai)
  })
})

describe("shownEditorThemeId", () => {
  test("names the theme the editor shows: a known choice, else GitHub for the mode", () => {
    expect(shownEditorThemeId("monokai", [], "light")).toBe("monokai")
    expect(shownEditorThemeId("default", [], "light")).toBe("github-light")
    expect(shownEditorThemeId("default", [], "dark")).toBe("github-dark")
    expect(shownEditorThemeId("removed-theme", [], "dark")).toBe("github-dark")
  })
})
