import { describe, expect, test, vi } from "vitest"
import {
  applyTrafficLightInset,
  DEFAULT_TRAFFIC_LIGHT_POSITION,
  TITLEBAR_TRAFFIC_LIGHT_POSITION,
  type TrafficLightWindow,
  trafficLightPositionFor,
} from "./trafficLights"

describe("trafficLightPositionFor", () => {
  test("picks the title-bar inset when the lights belong to the title bar", () => {
    expect(trafficLightPositionFor(true)).toEqual(TITLEBAR_TRAFFIC_LIGHT_POSITION)
  })

  test("picks the default sidebar-header inset otherwise", () => {
    expect(trafficLightPositionFor(false)).toEqual(DEFAULT_TRAFFIC_LIGHT_POSITION)
  })

  test("the title-bar inset sits to the right of the 56px rail at the same height", () => {
    expect(TITLEBAR_TRAFFIC_LIGHT_POSITION.x).toBeGreaterThan(56)
    expect(TITLEBAR_TRAFFIC_LIGHT_POSITION.y).toBe(DEFAULT_TRAFFIC_LIGHT_POSITION.y)
  })
})

describe("applyTrafficLightInset", () => {
  function fakeWindow(): TrafficLightWindow & { calls: (typeof DEFAULT_TRAFFIC_LIGHT_POSITION)[] } {
    const calls: (typeof DEFAULT_TRAFFIC_LIGHT_POSITION)[] = []
    return {
      calls,
      setWindowButtonPosition: (position) => {
        if (position) calls.push(position)
      },
    }
  }

  test("on darwin, moves the lights to the title-bar inset when collapsed", () => {
    const win = fakeWindow()
    expect(applyTrafficLightInset(win, true, "darwin")).toBe(true)
    expect(win.calls).toEqual([TITLEBAR_TRAFFIC_LIGHT_POSITION])
  })

  test("on darwin, resets to the explicit default inset when not in the title bar", () => {
    const win = fakeWindow()
    expect(applyTrafficLightInset(win, false, "darwin")).toBe(true)
    expect(win.calls).toEqual([DEFAULT_TRAFFIC_LIGHT_POSITION])
  })

  test("off darwin it is a no-op (the API is macOS-only)", () => {
    const win = fakeWindow()
    const spy = vi.spyOn(win, "setWindowButtonPosition")
    expect(applyTrafficLightInset(win, true, "linux")).toBe(false)
    expect(applyTrafficLightInset(win, false, "win32")).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  test("with no focused window it is a no-op", () => {
    expect(applyTrafficLightInset(null, true, "darwin")).toBe(false)
  })
})
