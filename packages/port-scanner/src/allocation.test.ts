import fc from "fast-check"
import { describe, expect, test } from "vitest"
import { type AllocationOptions, portBaseForSlot, portRangeForSlot } from "./allocation"

const DEFAULT_BASE = 30000
const DEFAULT_SIZE = 10
const DEFAULT_MAX = 65535

// Slots whose default-sized blocks all fit under the default max — keeps property
// runs free of the (separately tested) out-of-range throw path.
const validSlot = fc.nat({ max: Math.floor((DEFAULT_MAX - DEFAULT_BASE + 1) / DEFAULT_SIZE) - 1 })

describe("portRangeForSlot", () => {
  // Example-based: pin down the concrete layout.
  test("slot 0 starts at the base and spans `size` ports", () => {
    expect(portRangeForSlot(0)).toEqual({ start: 30000, end: 30009 })
  })
  test("consecutive slots are packed back to back", () => {
    expect(portRangeForSlot(1)).toEqual({ start: 30010, end: 30019 })
    expect(portRangeForSlot(2)).toEqual({ start: 30020, end: 30029 })
  })
  test("honours custom base/size", () => {
    const opts: AllocationOptions = { base: 4000, size: 5 }
    expect(portRangeForSlot(0, opts)).toEqual({ start: 4000, end: 4004 })
    expect(portRangeForSlot(3, opts)).toEqual({ start: 4015, end: 4019 })
  })

  test("throws when a slot would spill past max", () => {
    // base 65530, size 10 → slot 0 is 65530..65539, already over 65535.
    expect(() => portRangeForSlot(0, { base: 65530, size: 10 })).toThrow(/maximum port/)
    // Last fitting slot is fine; the next one throws.
    expect(() => portRangeForSlot(2, { base: 100, size: 10, max: 119 })).toThrow(/exceeds/)
    expect(portRangeForSlot(1, { base: 100, size: 10, max: 119 })).toEqual({
      start: 110,
      end: 119,
    })
  })

  test("rejects invalid slots", () => {
    expect(() => portRangeForSlot(-1)).toThrow(/non-negative integer/)
    expect(() => portRangeForSlot(1.5)).toThrow(/non-negative integer/)
  })
  test("rejects invalid options", () => {
    expect(() => portRangeForSlot(0, { base: 0 })).toThrow(/base/)
    expect(() => portRangeForSlot(0, { size: 0 })).toThrow(/size/)
    expect(() => portRangeForSlot(0, { max: 70000 })).toThrow(/max/)
    expect(() => portRangeForSlot(0, { base: 50000, max: 40000 })).toThrow(/must not exceed/)
  })

  // Property-based invariants over all valid slots.
  test("every range has exactly `size` ports", () => {
    fc.assert(
      fc.property(validSlot, (slot) => {
        const { start, end } = portRangeForSlot(slot)
        return end - start + 1 === DEFAULT_SIZE
      }),
    )
  })
  test("every range stays within [base, max]", () => {
    fc.assert(
      fc.property(validSlot, (slot) => {
        const { start, end } = portRangeForSlot(slot)
        return start >= DEFAULT_BASE && end <= DEFAULT_MAX && start <= end
      }),
    )
  })
  test("distinct slots never overlap", () => {
    fc.assert(
      fc.property(validSlot, validSlot, (a, b) => {
        fc.pre(a !== b)
        const ra = portRangeForSlot(a)
        const rb = portRangeForSlot(b)
        // Disjoint inclusive ranges: one ends strictly before the other begins.
        return ra.end < rb.start || rb.end < ra.start
      }),
    )
  })
  test("is deterministic — same slot yields the same range", () => {
    fc.assert(
      fc.property(validSlot, (slot) => {
        const first = portRangeForSlot(slot)
        const second = portRangeForSlot(slot)
        return first.start === second.start && first.end === second.end
      }),
    )
  })
  test("holds invariants under arbitrary valid options too", () => {
    fc.assert(
      fc.property(
        fc.record({
          base: fc.integer({ min: 1024, max: 50000 }),
          size: fc.integer({ min: 1, max: 50 }),
        }),
        fc.nat({ max: 20 }),
        ({ base, size }, slot) => {
          const { start, end } = portRangeForSlot(slot, { base, size })
          return start === base + slot * size && end - start + 1 === size
        },
      ),
    )
  })
})

describe("portBaseForSlot", () => {
  test("equals the range start for every valid slot", () => {
    fc.assert(
      fc.property(validSlot, (slot) => portBaseForSlot(slot) === portRangeForSlot(slot).start),
    )
  })
  test("matches range start under custom options", () => {
    const opts: AllocationOptions = { base: 8000, size: 4 }
    fc.assert(
      fc.property(fc.nat({ max: 100 }), (slot) => {
        return portBaseForSlot(slot, opts) === portRangeForSlot(slot, opts).start
      }),
    )
  })
})
