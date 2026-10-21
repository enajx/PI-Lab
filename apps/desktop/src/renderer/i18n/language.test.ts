import { beforeEach, expect, test, vi } from "vitest"
import {
  initializeInterfaceLanguage,
  readInterfaceLanguage,
  setInterfaceLanguage,
} from "./language"

const load = vi.hoisted(() => vi.fn())
vi.mock("./messages", () => ({
  translate: (_language: string, english: string) => english,
  hasMessages: (language: string) => language === "en",
  loadMessages: load,
}))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  load.mockReset()
  setInterfaceLanguage("en")
})

test("English applies without requesting a locale table", async () => {
  await initializeInterfaceLanguage()
  expect(load).not.toHaveBeenCalled()
  expect(document.documentElement.lang).toBe("en")
})

test("startup waits for the saved locale before the renderer can mount", async () => {
  const locale = deferred()
  load.mockReturnValueOnce(locale.promise)
  window.localStorage.setItem("pi-lab.interface.language", "es")
  let ready = false
  const initialization = Promise.resolve(initializeInterfaceLanguage()).then(() => {
    ready = true
  })
  await Promise.resolve()
  expect(ready).toBe(false)
  locale.resolve()
  await initialization
  expect(document.documentElement.lang).toBe("es")
})

test("a superseded locale load cannot replace a newer selection", async () => {
  const spanish = deferred()
  const arabic = deferred()
  load.mockReturnValueOnce(spanish.promise).mockReturnValueOnce(arabic.promise)
  const first = setInterfaceLanguage("es")
  const second = setInterfaceLanguage("ar")
  expect(readInterfaceLanguage()).toBe("en")
  arabic.resolve()
  await second
  spanish.resolve()
  await first
  expect(readInterfaceLanguage()).toBe("ar")
  expect(document.documentElement.dir).toBe("rtl")
})

test("a failed startup locale logs its error and permits an English fallback", async () => {
  const error = new Error("locale unavailable")
  const report = vi.spyOn(console, "error").mockImplementation(() => {})
  load.mockRejectedValueOnce(error)
  window.localStorage.setItem("pi-lab.interface.language", "ja")
  await initializeInterfaceLanguage()
  expect(readInterfaceLanguage()).toBe("en")
  expect(document.documentElement.lang).toBe("en")
  expect(report).toHaveBeenCalledWith("Could not load interface language", "ja", error)
  report.mockRestore()
})
