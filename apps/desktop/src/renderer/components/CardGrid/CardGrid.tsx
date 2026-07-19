import { cn } from "@pi-lab/ui"
import {
  type CSSProperties,
  createContext,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import "./cardGrid.css"

export const CARD_GRID_SURFACES = {
  dashboard: { baseColumnPx: 200, baseRowPx: 176 },
  cluster: { baseColumnPx: 280, baseRowPx: 128 },
} as const

export type CardGridSurface = keyof typeof CARD_GRID_SURFACES
/** Retained for callers compiled against the previous grid API. All cards are now uniform. */
export type CardSpanToken = "1x1"
export interface CardSpan {
  columns: 1
  rows: 1
}

const DEFAULT_SCALE = 1
const MIN_SCALE = 0.7
const MAX_SCALE = 1.6
const KEYBOARD_STEP = 0.05
const PIXELS_PER_SCALE_STEP = 320

interface CardGridContextValue {
  scale: number
  setScale: (scale: number) => void
}

const CardGridContext = createContext<CardGridContextValue | null>(null)

function storageKey(surface: CardGridSurface): string {
  return `pi-lab.cardGrid.${surface}.scale`
}

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(value * 100) / 100))
}

function readStoredScale(surface: CardGridSurface): number {
  if (typeof window === "undefined") return DEFAULT_SCALE
  const raw = window.localStorage.getItem(storageKey(surface))
  if (raw === null) return DEFAULT_SCALE
  const value = Number(raw)
  return Number.isFinite(value) ? clampScale(value) : DEFAULT_SCALE
}

function writeStoredScale(surface: CardGridSurface, scale: number): void {
  if (typeof window === "undefined") return
  if (scale === DEFAULT_SCALE) {
    window.localStorage.removeItem(storageKey(surface))
    return
  }
  window.localStorage.setItem(storageKey(surface), String(scale))
}

interface CardGridProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  surface: CardGridSurface
  /** Retained for surface callers; card size is now shared rather than per-card. */
  cardIds: readonly string[] | null
  children: ReactNode
  as?: "div" | "ul"
  testId?: string
}

/** Shared responsive grid with one smooth, persisted scale for every card on a surface. */
export function CardGrid({
  surface,
  cardIds: _cardIds,
  children,
  as = "div",
  testId,
  className,
  style,
  ...elementProps
}: CardGridProps) {
  const config = CARD_GRID_SURFACES[surface]
  const [scale, setScaleState] = useState(() => readStoredScale(surface))
  const context = useMemo(
    () => ({
      scale,
      setScale: (next: number) => {
        const normalized = clampScale(next)
        setScaleState(normalized)
        writeStoredScale(surface, normalized)
      },
    }),
    [scale, surface],
  )
  const Element = as
  const columnPx = Math.round(config.baseColumnPx * scale)
  const rowPx = Math.round(config.baseRowPx * scale)

  useEffect(() => {
    window.localStorage.removeItem(`pi-lab.cardGrid.${surface}.spans`)
  }, [surface])

  return (
    <CardGridContext.Provider value={context}>
      <Element
        {...elementProps}
        data-testid={testId}
        data-card-grid-surface={surface}
        data-card-grid-scale={scale}
        data-card-grid-base-column={config.baseColumnPx}
        data-card-grid-base-row={config.baseRowPx}
        className={cn("card-grid grid", className)}
        style={{
          gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${columnPx}px), 1fr))`,
          gridAutoRows: `minmax(${rowPx}px, auto)`,
          gridAutoFlow: "row",
          ...style,
        }}
      >
        {children}
      </Element>
    </CardGridContext.Provider>
  )
}

interface ResizableCardGridItemProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  cardId: string
  label: string
  children: ReactNode
  as?: "div" | "li"
  testId?: string
}

function scaleLabel(label: string, scale: number): string {
  return `Resize all cards from ${label}, currently ${Math.round(scale * 100)} percent`
}

/**
 * A card supplies an invisible corner drag target. Changing any card changes the
 * whole surface, which preserves a calm uniform grid rather than reflowing one
 * card into abrupt span states.
 */
export function ResizableCardGridItem({
  cardId,
  label,
  children,
  as = "div",
  testId,
  className,
  style,
  ...elementProps
}: ResizableCardGridItemProps) {
  const context = useContext(CardGridContext)
  if (!context) throw new Error("ResizableCardGridItem must be rendered inside CardGrid")

  const cleanupRef = useRef<() => void>(() => undefined)
  const Element = as
  const accessibleLabel = scaleLabel(label, context.scale)

  useEffect(() => () => cleanupRef.current(), [])

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    cleanupRef.current()

    const pointerId = event.pointerId
    const startX = event.clientX
    const startY = event.clientY
    const startScale = context.scale
    const target = event.currentTarget
    target.setPointerCapture?.(pointerId)

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onCancel)
      cleanupRef.current = () => undefined
    }
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return
      move.preventDefault()
      const distance = (move.clientX - startX + move.clientY - startY) / 2
      context.setScale(startScale + distance / PIXELS_PER_SCALE_STEP)
    }
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return
      cleanup()
    }
    const onCancel = (cancel: PointerEvent) => {
      if (cancel.pointerId !== pointerId) return
      cleanup()
      context.setScale(startScale)
    }

    cleanupRef.current = cleanup
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    let next = context.scale
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next += KEYBOARD_STEP
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next -= KEYBOARD_STEP
    if (event.key === "Home") next = DEFAULT_SCALE
    if (next === context.scale) return
    event.preventDefault()
    event.stopPropagation()
    context.setScale(next)
  }

  return (
    <Element
      {...elementProps}
      data-testid={testId}
      data-card-grid-item={cardId}
      data-card-span="1x1"
      className={cn("card-grid-item relative min-w-0", className)}
      style={style as CSSProperties}
    >
      <div className="h-full min-h-0">{children}</div>
      <button
        type="button"
        draggable={false}
        data-testid="card-resize-handle"
        data-card-id={cardId}
        aria-label={accessibleLabel}
        data-feature-label={`Resize ${label}`}
        data-feature-help="Drag the lower-right corner or use arrow keys to resize all cards"
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onDragStart={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        className="app-no-drag absolute right-0 bottom-0 z-20 size-6 cursor-nwse-resize touch-none bg-transparent opacity-0 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span data-testid="card-resize-status" aria-live="polite" className="sr-only">
          {accessibleLabel}
        </span>
      </button>
    </Element>
  )
}
