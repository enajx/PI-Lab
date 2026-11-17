import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react"
import { useTranslate } from "../../../../../../../i18n/language"
import type { ChartZoom } from "./chartZoom"

const BUTTON_CLASS =
  "flex size-5 items-center justify-center rounded border border-border bg-background/80 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"

/**
 * The +, − and reset zoom buttons, stacked in a column at the top right of the
 * chart. The parent must be `relative` and leave about 24 px of right margin so
 * the buttons sit beside the plot area, not over it.
 */
export function ZoomControls({ zoom }: { zoom: ChartZoom }) {
  const t = useTranslate()
  return (
    <div className="absolute top-1 right-0 flex flex-col gap-1">
      <button
        type="button"
        data-testid="analysis-chart-zoom-in"
        aria-label={t("Zoom in")}
        title={t("Zoom in")}
        data-feature-label={t("Zoom in")}
        data-feature-help={t(
          "Show the middle half of the x range. You can also drag across the chart to zoom into a range.",
        )}
        disabled={!zoom.canZoomIn}
        onClick={zoom.zoomIn}
        className={BUTTON_CLASS}
      >
        <ZoomIn className="size-3" aria-hidden />
      </button>
      <button
        type="button"
        data-testid="analysis-chart-zoom-out"
        aria-label={t("Zoom out")}
        title={t("Zoom out")}
        data-feature-label={t("Zoom out")}
        data-feature-help={t("Show twice the x range, up to all the data.")}
        disabled={!zoom.zoomed}
        onClick={zoom.zoomOut}
        className={BUTTON_CLASS}
      >
        <ZoomOut className="size-3" aria-hidden />
      </button>
      <button
        type="button"
        data-testid="analysis-chart-zoom-reset"
        aria-label={t("Reset zoom")}
        title={t("Reset zoom")}
        data-feature-label={t("Reset zoom")}
        data-feature-help={t("Show all the data. Double-clicking the chart does the same.")}
        disabled={!zoom.zoomed}
        onClick={zoom.reset}
        className={BUTTON_CLASS}
      >
        <RotateCcw className="size-3" aria-hidden />
      </button>
    </div>
  )
}
