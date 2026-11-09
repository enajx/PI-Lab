import { expect, test } from "vitest"
import { browserUrlForNewWindow, isTrustedNavigation } from "./mainWindowNavigation"

test("packaged navigation allows app entries and hashes and rejects other null-origin URLs", () => {
  const entries = ["file:///app/index.html", "file:///app/quick.html"]
  expect(isTrustedNavigation("file:///app/index.html#/projects/1", entries)).toBe(true)
  expect(isTrustedNavigation("file:///app/quick.html?setup=skip#/quick", entries)).toBe(true)
  for (const url of [
    "file:///tmp/other.html",
    "file:///app/index.html.evil",
    "data:text/html,hello",
    "https://example.com",
  ]) {
    expect(isTrustedNavigation(url, entries)).toBe(false)
  }
})

test("development navigation allows only the configured HTTP origin", () => {
  const entries = ["http://localhost:5173/"]
  expect(isTrustedNavigation("http://localhost:5173/quick.html#/quick", entries)).toBe(true)
  expect(isTrustedNavigation("http://localhost:5174/index.html", entries)).toBe(false)
  expect(isTrustedNavigation("file:///app/index.html", entries)).toBe(false)
})

test("links that open a new window go to the browser only for https addresses", () => {
  expect(browserUrlForNewWindow("https://www.overleaf.com/user/settings")).toBe(
    "https://www.overleaf.com/user/settings",
  )
  expect(browserUrlForNewWindow("http://example.com/")).toBeNull()
  expect(browserUrlForNewWindow("file:///etc/passwd")).toBeNull()
  expect(browserUrlForNewWindow("javascript:alert(1)")).toBeNull()
  expect(browserUrlForNewWindow("not a url")).toBeNull()
})
