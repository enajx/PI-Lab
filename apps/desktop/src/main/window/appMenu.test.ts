import { afterEach, describe, expect, test, vi } from "vitest"
import { setNativeLanguage } from "../i18n/nativeLanguage"

const menu = vi.hoisted(() => ({
  buildFromTemplate: vi.fn((template) => template),
  setApplicationMenu: vi.fn(),
}))
const appState = vi.hoisted(() => ({ isPackaged: false, name: "PI Lab" }))
vi.mock("electron", () => ({
  Menu: menu,
  app: {
    get isPackaged() {
      return appState.isPackaged
    },
    getName: () => appState.name,
  },
}))

import { installAppMenu, setReadyUpdateMenuItem } from "./appMenu"

afterEach(() => {
  setReadyUpdateMenuItem(null)
  setNativeLanguage("en")
  appState.isPackaged = false
  appState.name = "PI Lab"
  vi.clearAllMocks()
})

describe("app menu", () => {
  test.skipIf(process.platform !== "darwin")(
    "offers Restart to Update only when a public update is ready",
    () => {
      const restart = vi.fn()
      setReadyUpdateMenuItem({ version: "1.2.0", restart })
      const template = menu.buildFromTemplate.mock.lastCall?.[0]
      const submenu = template?.[0]?.submenu
      const item = submenu?.find?.(
        (entry: { label?: string }) => entry.label === "Restart to Update",
      )
      expect(item).toBeDefined()
      expect(JSON.stringify(submenu)).toContain("Ready to update to 1.2.0")
      item?.click?.()
      expect(restart).toHaveBeenCalledOnce()
    },
  )

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

  test.skipIf(process.platform !== "darwin").each(["Alpha", "Beta"])(
    "labels the %s app menu without offering Stable's pilab command",
    (name) => {
      appState.isPackaged = true
      appState.name = `PI Lab ${name}`
      installAppMenu()
      const template = menu.buildFromTemplate.mock.calls[0]?.[0]
      const appMenu = template[0]
      expect(appMenu.label).toBe(`PI Lab ${name}`)
      expect(JSON.stringify(appMenu)).toContain(`About PI Lab ${name}`)
      expect(JSON.stringify(appMenu)).toContain(`Quit PI Lab ${name}`)
      expect(JSON.stringify(appMenu)).not.toContain("Install 'pilab' command")
    },
  )

  test.skipIf(process.platform === "darwin")("uses the File menu on Linux and Windows", () => {
    appState.isPackaged = true
    appState.name = "PI Lab Beta"
    installAppMenu()
    const template = menu.buildFromTemplate.mock.calls[0]?.[0]
    expect(template[0].label).toBe("File")
    expect(template[0].submenu).toEqual([{ role: "quit", label: "Quit PI Lab Beta" }])
    expect(JSON.stringify(template)).not.toContain("Install 'pilab' command")
  })
})
