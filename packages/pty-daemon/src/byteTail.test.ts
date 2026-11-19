import { expect, test } from "vitest"
import { ByteTail } from "./byteTail"

test("retains the exact byte suffix and its offsets across partial, oversized, and many small appends", () => {
  const tail = new ByteTail(37)
  let expected = Buffer.alloc(0)
  let total = 0
  for (const text of [
    "",
    "a".repeat(50),
    "β🙂",
    ...Array.from({ length: 3000 }, (_, index) => String(index)),
  ]) {
    const chunk = Buffer.from(text)
    tail.append(chunk)
    total += chunk.length
    expected = Buffer.concat([expected, chunk]).subarray(-37)
    expect(tail.end).toBe(total)
    expect(tail.start).toBe(total - expected.length)
    expect(tail.from(tail.start)).toEqual(expected)
    if (expected.length >= 5) expect(tail.from(total - 5)).toEqual(expected.subarray(-5))
  }
  expect(tail.from(tail.start - 1)).toBeNull()
  expect(tail.from(total + 1)).toBeNull()
  const disabled = new ByteTail(0)
  disabled.append(Buffer.from("unused"))
  expect(disabled.from(6)).toEqual(Buffer.alloc(0))
  expect(disabled.from(0)).toBeNull()
})
