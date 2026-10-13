import { describe, expect, test } from "vitest"
import { setInterfaceLanguage } from "../../i18n/language"
import { type RejectedRead, rejectedReadMessage } from "./rejectedRead"

describe("rejectedReadMessage", () => {
  test("formats an oversized-file warning in the selected interface language", () => {
    setInterfaceLanguage("es")
    const read = {
      status: "oversized",
      relPath: "large.md",
      size: 12345,
      limit: 10000,
    } as RejectedRead
    expect(rejectedReadMessage(read)).toBe(
      "large.md tiene 12.345 bytes, por encima del límite de 10.000 bytes del editor.",
    )
    setInterfaceLanguage("en")
  })
})
