import { afterEach, describe, expect, test, vi } from "vitest"
import { setNativeLanguage } from "../i18n/nativeLanguage"

const menu = vi.hoisted(() => ({
  buildFromTemplate: vi.fn((template) => template),
  setApplicationMenu: vi.fn(),
}))
vi.mock("electron", () => ({ Menu: menu }))

import { installAppMenu } from "./appMenu"

afterEach(() => {
  setNativeLanguage("en")
  vi.clearAllMocks()
})

describe("app menu", () => {
  test("rebuilds localized native labels and never binds Close Window", () => {
    setNativeLanguage("es")
    installAppMenu()
    const template = menu.buildFromTemplate.mock.calls[0]?.[0]
    expect(template).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Editar" })]))
    expect(JSON.stringify(template)).not.toContain('"role":"close"')
    setNativeLanguage("ar")
    installAppMenu()
    expect(menu.buildFromTemplate.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "تحرير" })]),
    )
  })
})
