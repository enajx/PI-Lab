import { EditorState } from "@codemirror/state"
import { describe, expect, test } from "vitest"
import { DEFAULT_EDITOR_THEME_ID, EDITOR_THEMES, editorThemeExtension } from "./editorThemes"

describe("editorThemes registry", () => {
  test("holds exactly four light themes followed by four dark themes", () => {
    expect(EDITOR_THEMES).toHaveLength(8)
    expect(EDITOR_THEMES.filter((theme) => theme.mode === "light")).toHaveLength(4)
    expect(EDITOR_THEMES.filter((theme) => theme.mode === "dark")).toHaveLength(4)
    // Order is light block first, dark block second — that order drives the picker.
    expect(EDITOR_THEMES.slice(0, 4).every((theme) => theme.mode === "light")).toBe(true)
    expect(EDITOR_THEMES.slice(4).every((theme) => theme.mode === "dark")).toBe(true)
  })

  test("every label ends with the suffix matching its mode", () => {
    for (const theme of EDITOR_THEMES) {
      expect(theme.label.endsWith(theme.mode === "light" ? "(Light)" : "(Dark)")).toBe(true)
    }
  })

  test("ids are unique and non-empty and labels are non-empty", () => {
    const ids = EDITOR_THEMES.map((theme) => theme.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const theme of EDITOR_THEMES) {
      expect(theme.id.length).toBeGreaterThan(0)
      expect(theme.label.length).toBeGreaterThan(0)
    }
  })

  test("the default id is a registered light theme", () => {
    const fallback = EDITOR_THEMES.find((theme) => theme.id === DEFAULT_EDITOR_THEME_ID)
    expect(fallback).toBeDefined()
    expect(fallback?.mode).toBe("light")
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
    expect(editorThemeExtension("one-dark")).toBe(known?.extension)
  })

  test("falls back to the default theme's extension for undefined/empty/unknown/legacy ids", () => {
    const fallback = EDITOR_THEMES.find((theme) => theme.id === DEFAULT_EDITOR_THEME_ID)?.extension
    expect(fallback).toBeDefined()
    expect(editorThemeExtension(undefined)).toBe(fallback)
    expect(editorThemeExtension("")).toBe(fallback)
    expect(editorThemeExtension("not-a-real-theme")).toBe(fallback)
    // "default" is the retired sentinel still persisted by older rows.
    expect(editorThemeExtension("default")).toBe(fallback)
  })

  test("never throws and never returns an unstyled buffer", () => {
    for (const id of [undefined, "", "default", "not-a-real-theme", "solarized-light"]) {
      expect(() => editorThemeExtension(id)).not.toThrow()
      expect(editorThemeExtension(id)).not.toEqual([])
    }
  })
})
