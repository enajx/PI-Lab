import { render, screen } from "@testing-library/react"
import { afterEach, expect, test } from "vitest"
import { setInterfaceLanguage } from "../../../../../../../i18n/language"
import { ChangeList } from "./ChangeList"

afterEach(() => setInterfaceLanguage("en"))

test("shows the empty changes state in the selected interface language", () => {
  setInterfaceLanguage("es")
  render(<ChangeList changes={[]} emptyTestId="changes-empty" />)
  expect(screen.getByTestId("changes-empty").textContent).toBe("Sin cambios")
})
