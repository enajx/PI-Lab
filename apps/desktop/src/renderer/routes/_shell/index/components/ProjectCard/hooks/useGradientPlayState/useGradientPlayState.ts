import { type RefObject, useEffect } from "react"

/**
 * Pauses a project card's gradient morph when it can't be seen, to keep a grid of
 * cards cheap. The animated layer keeps running only while it is **on-screen**
 * (IntersectionObserver) AND the **window is focused & visible** (focus/blur +
 * `visibilitychange`). Anything else parks it at `animation-play-state: paused`.
 *
 * It writes `style.animationPlayState` directly on the layer element — no React
 * state, so toggling visibility never re-renders the card. When the relevant
 * browser APIs are missing (e.g. jsdom has no `IntersectionObserver`) it defaults
 * to "running" so the animation degrades to always-on rather than always-off.
 */
export function useGradientPlayState(ref: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return

    // Default each input to its "playing" state so missing APIs ⇒ always running.
    let isIntersecting = true
    let isFocused =
      typeof document !== "undefined" && typeof document.hasFocus === "function"
        ? document.hasFocus()
        : true
    let isVisible =
      typeof document !== "undefined" && typeof document.visibilityState === "string"
        ? document.visibilityState === "visible"
        : true

    const apply = () => {
      const playState = isIntersecting && isFocused && isVisible ? "running" : "paused"
      el.style.animationPlayState = playState
      el.style.setProperty("--gradient-play-state", playState)
      el.style.setProperty("--gradient-will-change", playState === "running" ? "transform" : "auto")
    }
    apply()

    const onFocus = () => {
      isFocused = true
      apply()
    }
    const onBlur = () => {
      isFocused = false
      apply()
    }
    const onVisibility = () => {
      isVisible = document.visibilityState === "visible"
      apply()
    }

    window.addEventListener("focus", onFocus)
    window.addEventListener("blur", onBlur)
    document.addEventListener("visibilitychange", onVisibility)

    // jsdom (and very old engines) lack IntersectionObserver — guard and treat the
    // layer as visible there, so tests and fallbacks keep the animation running.
    let observer: IntersectionObserver | undefined
    if (typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1]
        if (!entry) return
        isIntersecting = entry.isIntersecting
        apply()
      })
      observer.observe(el)
    }

    return () => {
      window.removeEventListener("focus", onFocus)
      window.removeEventListener("blur", onBlur)
      document.removeEventListener("visibilitychange", onVisibility)
      observer?.disconnect()
    }
  }, [ref])
}
