import { type RefObject, useLayoutEffect, useState } from "react"

/** Space kept between the centered item and the title or the right-hand controls. */
const GAP_PX = 12

export type CenteredPlacement = "center" | "after-title"

/**
 * Whether an item (`item`) fits centered on a top bar (`bar`): centered, it
 * must not reach the full, untruncated width of the title (`title`) or the
 * right-hand controls (`right`). Returns "after-title" when it does not fit
 * (and before the first measurement). Measures again whenever any of them
 * changes size; `content` is anything that changes the title text.
 */
export function useCenteredPlacement(
  bar: RefObject<HTMLElement | null>,
  title: RefObject<HTMLElement | null>,
  item: RefObject<HTMLElement | null>,
  right: RefObject<HTMLElement | null>,
  content: string,
): CenteredPlacement {
  const [placement, setPlacement] = useState<CenteredPlacement>("after-title")
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new title text needs a new measurement
  useLayoutEffect(() => {
    const elements = [bar.current, title.current, item.current, right.current]
    const [barEl, titleEl, itemEl, rightEl] = elements
    if (!barEl || !titleEl || !itemEl || !rightEl) return
    const measure = (): void => {
      const barBox = barEl.getBoundingClientRect()
      // The title's lines truncate; their scroll width is the full text width.
      const titleWidth = Math.max(
        0,
        ...[...titleEl.children].map((child) => (child as HTMLElement).scrollWidth),
      )
      const titleEnd = titleEl.getBoundingClientRect().left + titleWidth
      const width = itemEl.getBoundingClientRect().width
      const middle = barBox.left + barBox.width / 2
      const fits =
        middle - width / 2 >= titleEnd + GAP_PX &&
        middle + width / 2 <= rightEl.getBoundingClientRect().left - GAP_PX
      setPlacement(fits ? "center" : "after-title")
    }
    measure()
    const observer = new ResizeObserver(measure)
    for (const element of elements) if (element) observer.observe(element)
    return () => observer.disconnect()
  }, [bar, title, item, right, content])
  return placement
}
