import { type RefObject, useEffect } from "react"

/** Run the card animation only while active, visible, and focused. */
export function useGradientPlayState(ref: RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return

    // Missing browser APIs leave the animation enabled.
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
      const playState = active && isIntersecting && isFocused && isVisible ? "running" : "paused"
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
  }, [ref, active])
}
