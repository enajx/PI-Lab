import { expect, test } from "vitest"
import { Scrollback } from "./scrollback"

test("retains the exact suffix across partial, oversized, and many small appends", () => {
  const scrollback = new Scrollback(37)
  let expected = ""
  for (const chunk of [
    "",
    "a".repeat(50),
    "β🙂",
    ...Array.from({ length: 3000 }, (_, index) => String(index)),
  ]) {
    scrollback.append(chunk)
    expected = (expected + chunk).slice(-37)
    expect(scrollback.text()).toBe(expected)
  }
  const disabled = new Scrollback(0)
  disabled.append("unused")
  expect(disabled.text()).toBe("")
})
