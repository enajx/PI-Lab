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
import { useTranslate } from "../../i18n/language"
import "./cardGrid.css"

export const CARD_GRID_SURFACES = {
  dashboard: { baseColumnPx: 220, baseRowPx: 236 },
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
/** Card sizes snap to 10% steps of the surface's base size, on each axis. */
const SIZE_STEP = 0.1

/** Shared card size on a surface, as multiples of the base column width and row height. */
export interface CardGridSize {
  width: number
  height: number
}

const DEFAULT_SIZE: CardGridSize = { width: DEFAULT_SCALE, height: DEFAULT_SCALE }

interface CardGridContextValue {
  size: CardGridSize
  baseColumnPx: number
  baseRowPx: number
  setSize: (size: CardGridSize) => void
}

const CardGridContext = createContext<CardGridContextValue | null>(null)

function storageKey(surface: CardGridSurface): string {
  return `pi-lab.cardGrid.${surface}.size`
}

/** The key of the old single shared scale, migrated to width and height on first read. */
function legacyScaleKey(surface: CardGridSurface): string {
  return `pi-lab.cardGrid.${surface}.scale`
}

/** Snap a scale to the nearest 10% step and keep it within the allowed range. */
function snapScale(value: number): number {
  const snapped = Math.round(value * 10) / 10
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, snapped))
}

function snapSize(size: CardGridSize): CardGridSize {
  return { width: snapScale(size.width), height: snapScale(size.height) }
}

function writeStoredSize(surface: CardGridSurface, size: CardGridSize): void {
  if (typeof window === "undefined") return
  if (size.width === DEFAULT_SCALE && size.height === DEFAULT_SCALE) {
    window.localStorage.removeItem(storageKey(surface))
    return
  }
  window.localStorage.setItem(storageKey(surface), JSON.stringify(size))
}

/** A finite number from stored JSON, or null when the value is missing or malformed. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * Read the stored card size. An old single `scale` value is moved to both width
 * and height (snapped to 10%), saved under the new key, and the old key removed.
 * A malformed stored value falls back to the base size.
 */
function readStoredSize(surface: CardGridSurface): CardGridSize {
  if (typeof window === "undefined") return DEFAULT_SIZE
  const legacy = window.localStorage.getItem(legacyScaleKey(surface))
  if (legacy !== null) {
    window.localStorage.removeItem(legacyScaleKey(surface))
    const value = Number(legacy)
    if (Number.isFinite(value)) {
      const migrated = snapSize({ width: value, height: value })
      writeStoredSize(surface, migrated)
      return migrated
    }
  }
  const raw = window.localStorage.getItem(storageKey(surface))
  if (raw === null) return DEFAULT_SIZE
  const parsed: unknown = JSON.parse(raw)
  const record =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
  const width = finiteOrNull(record.width)
  const height = finiteOrNull(record.height)
  if (width === null || height === null) return DEFAULT_SIZE
  return snapSize({ width, height })
}

/**
 * The shared card height as a multiple of the base row height, or 1 outside a
 * CardGrid. Cards use it to scale inner parts (e.g. a thumbnail) with the card.
 */
export function useCardGridHeightScale(): number {
  return useContext(CardGridContext)?.size.height ?? DEFAULT_SCALE
}

interface CardGridProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  surface: CardGridSurface
  /** Retained for surface callers; card size is now shared rather than per-card. */
  cardIds: readonly string[] | null
  children: ReactNode
  as?: "div" | "ul"
  testId?: string
}

/** Shared responsive grid with one persisted width and height for every card on a surface. */
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
  const [size, setSizeState] = useState(() => readStoredSize(surface))
  const context = useMemo(
    () => ({
      size,
      baseColumnPx: config.baseColumnPx,
      baseRowPx: config.baseRowPx,
      setSize: (next: CardGridSize) => {
        const normalized = snapSize(next)
        setSizeState(normalized)
        writeStoredSize(surface, normalized)
      },
    }),
    [size, surface, config],
  )
  const Element = as
  const columnPx = Math.round(config.baseColumnPx * size.width)
  const rowPx = Math.round(config.baseRowPx * size.height)
  const boundedColumns = surface === "dashboard"

  useEffect(() => {
    window.localStorage.removeItem(`pi-lab.cardGrid.${surface}.spans`)
  }, [surface])

  return (
    <CardGridContext.Provider value={context}>
      <Element
        {...elementProps}
        data-testid={testId}
        data-card-grid-surface={surface}
        data-card-grid-width={size.width}
        data-card-grid-height={size.height}
        data-card-grid-base-column={config.baseColumnPx}
        data-card-grid-base-row={config.baseRowPx}
        className={cn("card-grid grid", className)}
        style={
          {
            gridTemplateColumns: boundedColumns
              ? `repeat(auto-fill, minmax(min(100%, ${columnPx}px), ${columnPx}px))`
              : `repeat(auto-fit, minmax(min(100%, ${columnPx}px), 1fr))`,
            gridAutoRows: `minmax(${rowPx}px, auto)`,
            gridAutoFlow: "row",
            "--card-grid-column": `${columnPx}px`,
            "--card-grid-row": `${rowPx}px`,
            justifyContent: boundedColumns ? "start" : undefined,
            ...style,
          } as CSSProperties
        }
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

function sizeLabel(label: string, size: CardGridSize, t: (english: string) => string): string {
  const width = `${t("width")} ${Math.round(size.width * 100)} ${t("percent")}`
  const height = `${t("height")} ${Math.round(size.height * 100)} ${t("percent")}`
  return `${t("Resize all cards from")} ${label}, ${t("currently")} ${width}, ${height}`
}

/**
 * A card supplies an invisible corner drag target. Horizontal movement changes the
 * shared card width and vertical movement the shared height, each snapping to 10%
 * steps of the base size, so the corner follows the pointer in visible steps.
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
  const t = useTranslate()
  const context = useContext(CardGridContext)
  if (!context) throw new Error("ResizableCardGridItem must be rendered inside CardGrid")

  const cleanupRef = useRef<() => void>(() => undefined)
  const Element = as
  const accessibleLabel = sizeLabel(label, context.size, t)

  useEffect(() => () => cleanupRef.current(), [])

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    cleanupRef.current()

    const pointerId = event.pointerId
    const startX = event.clientX
    const startY = event.clientY
    const direction = document.documentElement.dir === "rtl" ? -1 : 1
    const startSize = context.size
    const { baseColumnPx, baseRowPx, setSize } = context
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
      setSize({
        width: startSize.width + (direction * (move.clientX - startX)) / baseColumnPx,
        height: startSize.height + (move.clientY - startY) / baseRowPx,
      })
    }
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return
      cleanup()
    }
    const onCancel = (cancel: PointerEvent) => {
      if (cancel.pointerId !== pointerId) return
      cleanup()
      setSize(startSize)
    }

    cleanupRef.current = cleanup
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const rtl = document.documentElement.dir === "rtl"
    const { width, height } = context.size
    const wider = (event.key === "ArrowRight" && !rtl) || (event.key === "ArrowLeft" && rtl)
    const narrower = (event.key === "ArrowLeft" && !rtl) || (event.key === "ArrowRight" && rtl)
    let next: CardGridSize | null = null
    if (wider) next = { width: width + SIZE_STEP, height }
    if (narrower) next = { width: width - SIZE_STEP, height }
    if (event.key === "ArrowDown") next = { width, height: height + SIZE_STEP }
    if (event.key === "ArrowUp") next = { width, height: height - SIZE_STEP }
    if (event.key === "Home") next = DEFAULT_SIZE
    if (next === null) return
    event.preventDefault()
    event.stopPropagation()
    context.setSize(next)
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
        data-feature-label={`${t("Resize")} ${label}`}
        data-feature-help={t("Drag the lower-right corner or use arrow keys to resize all cards")}
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
        className="app-no-drag absolute end-0 bottom-0 z-20 size-6 cursor-nwse-resize touch-none bg-transparent opacity-0 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rtl:left-0 rtl:right-auto rtl:cursor-nesw-resize"
      >
        <span data-testid="card-resize-status" aria-live="polite" className="sr-only">
          {accessibleLabel}
        </span>
      </button>
    </Element>
  )
}
