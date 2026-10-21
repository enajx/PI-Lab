import { expect, test } from "vitest"
import { loadMessages, translate } from "./messages"

test("locale tables retain prior lookup precedence and fall back for unknown copy", async () => {
  await Promise.all([loadMessages("es"), loadMessages("ja")])
  expect(translate("es", "Project template")).toBe("Plantilla de proyecto")
  expect(translate("ja", "Library")).toBe("ライブラリ")
  expect(translate("es", "Untranslated test wording")).toBe("Untranslated test wording")
  expect(translate("en", "Save")).toBe("Save")
})
