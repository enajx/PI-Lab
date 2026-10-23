import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import {
  getNativeLanguage,
  loadNativeLanguage,
  nativeText,
  saveNativeLanguage,
  setNativeLanguage,
} from "./nativeLanguage"

const dir = mkdtempSync(join(tmpdir(), "pi-lab-native-language-"))

afterEach(() => {
  setNativeLanguage("en")
  rmSync(dir, { recursive: true, force: true })
})

describe("native language preference", () => {
  test("persists and loads each supported language, rejecting unknown values", () => {
    for (const code of ["en", "zh-CN", "ko", "ja", "es", "ar", "nb"] as const) {
      saveNativeLanguage(dir, code)
      setNativeLanguage("en")
      loadNativeLanguage(dir)
      expect(getNativeLanguage()).toBe(code)
      expect(readFileSync(join(dir, "interface-language"), "utf8")).toBe(code)
    }
    expect(setNativeLanguage("xx")).toBe(false)
    expect(getNativeLanguage()).toBe("nb")
  })

  test("translates app menu and notification text in every language", () => {
    for (const code of ["zh-CN", "ko", "ja", "es", "ar", "nb"] as const) {
      setNativeLanguage(code)
      expect(nativeText("Edit")).not.toBe("Edit")
      expect(nativeText("Routine completed")).not.toBe("Routine completed")
      expect(nativeText("Agent needs input")).not.toBe("Agent needs input")
      expect(nativeText("PI Lab database could not be opened")).not.toBe(
        "PI Lab database could not be opened",
      )
    }
  })
})
