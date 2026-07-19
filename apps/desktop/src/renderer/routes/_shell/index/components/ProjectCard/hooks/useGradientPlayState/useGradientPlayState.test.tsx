import { act, render, screen } from "@testing-library/react"
import { type RefObject, useRef } from "react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { useGradientPlayState } from "./useGradientPlayState"

class MockIntersectionObserver implements IntersectionObserver {
  static instances: MockIntersectionObserver[] = []

  readonly root = null
  readonly rootMargin = "0px"
  readonly thresholds = [0]
  readonly disconnect = vi.fn()
  readonly observe = vi.fn()
  readonly takeRecords = vi.fn(() => [])
  readonly unobserve = vi.fn()

  constructor(private readonly callback: IntersectionObserverCallback) {
    MockIntersectionObserver.instances.push(this)
  }

  emit(isIntersecting: boolean): void {
    this.callback([{ isIntersecting } as IntersectionObserverEntry], this)
  }
}

function GradientHarness() {
  const ref = useRef<HTMLDivElement | null>(null)
  useGradientPlayState(ref as RefObject<HTMLDivElement | null>)
  return <div data-testid="gradient" ref={ref} />
}

describe("useGradientPlayState", () => {
  beforeEach(() => {
    MockIntersectionObserver.instances = []
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver)
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  test("runs on-screen and pauses while the gradient is off-screen", () => {
    render(<GradientHarness />)

    const gradient = screen.getByTestId("gradient")
    const observer = MockIntersectionObserver.instances[0]
    expect(observer?.observe).toHaveBeenCalledWith(gradient)
    expect(gradient.style.animationPlayState).toBe("running")
    expect(gradient.style.getPropertyValue("--gradient-play-state")).toBe("running")
    expect(gradient.style.getPropertyValue("--gradient-will-change")).toBe("transform")

    act(() => observer?.emit(false))
    expect(gradient.style.animationPlayState).toBe("paused")
    expect(gradient.style.getPropertyValue("--gradient-play-state")).toBe("paused")
    expect(gradient.style.getPropertyValue("--gradient-will-change")).toBe("auto")

    act(() => observer?.emit(true))
    expect(gradient.style.animationPlayState).toBe("running")
  })

  test("pauses on window blur, resumes on focus, and still requires an on-screen element", () => {
    render(<GradientHarness />)

    const gradient = screen.getByTestId("gradient")
    const observer = MockIntersectionObserver.instances[0]

    act(() => window.dispatchEvent(new Event("blur")))
    expect(gradient.style.animationPlayState).toBe("paused")

    act(() => observer?.emit(false))
    act(() => window.dispatchEvent(new Event("focus")))
    expect(gradient.style.animationPlayState).toBe("paused")

    act(() => observer?.emit(true))
    expect(gradient.style.animationPlayState).toBe("running")
  })

  test("disconnects and removes pause/resume listeners on cleanup", () => {
    const { unmount } = render(<GradientHarness />)

    const gradient = screen.getByTestId("gradient")
    const observer = MockIntersectionObserver.instances[0]
    unmount()

    expect(observer?.disconnect).toHaveBeenCalledOnce()

    act(() => window.dispatchEvent(new Event("blur")))
    expect(gradient.style.animationPlayState).toBe("running")
  })
})
