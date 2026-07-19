import { cleanup } from "@testing-library/react"
import { afterEach, beforeEach } from "vitest"

// Node 25 exposes native `localStorage`/`sessionStorage` globals that are inert without
// `--localstorage-file` (their `getItem`/`setItem` are undefined) and shadow jsdom's own
// Web Storage. Renderer tests that read persisted UI state (e.g. ThemeProvider) then throw
// "getItem is not a function". Install a real in-memory Storage so the jsdom suite works on
// any Node version.
function createStorage(): Storage {
  const entries = new Map<string, string>()
  return {
    get length() {
      return entries.size
    },
    clear() {
      entries.clear()
    },
    getItem(key: string) {
      return entries.get(key) ?? null
    },
    key(index: number) {
      return Array.from(entries.keys())[index] ?? null
    },
    removeItem(key: string) {
      entries.delete(key)
    },
    setItem(key: string, value: string) {
      entries.set(key, String(value))
    },
  } as Storage
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  Object.defineProperty(globalThis, name, { configurable: true, value: createStorage() })
}

// jsdom doesn't implement `scrollIntoView`; stub it so components that keep a selection in
// view (e.g. the Library browser's keyboard cursor) don't throw under test.
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = () => {}
}

// Renderer (jsdom) component tests: reset persisted state + unmount/reset the DOM between
// tests so React Testing Library mounts and stored UI state don't leak across cases
// (md/engineering/testing-and-build.md).
beforeEach(() => {
  globalThis.localStorage.clear()
  globalThis.sessionStorage.clear()
})

afterEach(() => {
  cleanup()
})
