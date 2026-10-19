/// <reference types="vite/client" />
import { ChevronLeft, ChevronRight, Star } from "lucide-react"
import { type KeyboardEvent, useEffect, useRef, useState } from "react"
import {
  APP_ICON_DEFAULT_SELECTION,
  APP_ICON_JOYPLOT_STYLES,
  APP_ICON_PALETTES,
  type AppIconBridge,
  type AppIconFamily,
  type AppIconFavorite,
  type AppIconPalette,
  type AppIconSelection,
  applyAppIconFavorite,
  isAppIconSelection,
  type JoyplotStyleId,
  matchesAppIconFavorite,
  type PiIconFontId,
  snapshotAppIconFavorite,
} from "../../../../../../shared/appIcon"
import { useTranslate } from "../../../../../i18n/language"
import { PI_ICON_FONTS } from "./piIconFonts"

const JOYPLOT_STYLE_LABELS: Record<JoyplotStyleId, string> = {
  "25": "Ascending peaks",
  "26": "Descending peaks",
  "27": "Wide domes",
  "28": "Split peaks",
  "29": "Right tails",
  "30": "Left tails",
  "31": "Four steps",
  "32": "Centered crests",
  "33": "Paired hills",
  "34": "Gentle waves",
  "35": "Flat tops",
  "36": "Two peaks",
  "37": "Ascending peaks, rounder tails",
  "38": "Ascending peaks, slightly fuller tails",
  "39": "Ascending peaks, fuller tails",
  "40": "Ascending peaks, rounded falloff",
  "41": "Ascending peaks, thick tails",
  "42": "Ascending peaks, broad falloff",
  "43": "Centered crests, position 1",
  "44": "Centered crests, position 2",
  "45": "Centered crests, position 3",
  "46": "Centered crests, position 4",
  "47": "Centered crests, position 5",
  "48": "Centered crests, position 6",
  "49": "Centered crests, position 7",
  "50": "Centered crests, position 8",
  "51": "Centered crests, position 9",
  "52": "Centered crests, position 10",
}

const PALETTE_LABELS: Partial<Record<AppIconPalette, string>> = {
  magma: "Magma",
  "magma-iris": "Magma + Iris",
  viridis: "Viridis",
}

function paletteLabel(palette: AppIconPalette): string {
  return PALETTE_LABELS[palette] ?? palette[0]?.toUpperCase().concat(palette.slice(1)) ?? palette
}

/** Wrap previous/next navigation through one family's available variants. */
function cycle<T extends string>(options: readonly T[], selected: T, direction: -1 | 1): T {
  const first = options[0]
  if (!first) throw new Error("No app icon variants are available.")
  const current = options.indexOf(selected)
  if (current === -1) return direction === 1 ? first : (options[options.length - 1] ?? first)
  const next = (current + direction + options.length) % options.length
  return options[next] ?? first
}

function iconBridge(): AppIconBridge | undefined {
  return (window as Window & { piLab?: { appIcon?: AppIconBridge } }).piLab?.appIcon
}

/** Settings → Appearance icon picker with one preview and saved, live choices. */
export function AppIconGallery() {
  const t = useTranslate()
  const [channel, setChannel] = useState<"alpha" | "beta" | "stable">("stable")
  const [selection, setSelection] = useState<AppIconSelection>(APP_ICON_DEFAULT_SELECTION)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewSrc, setPreviewSrc] = useState<string>()
  const latestSelection = useRef<AppIconSelection>(APP_ICON_DEFAULT_SELECTION)
  const lastSaved = useRef<AppIconSelection>(APP_ICON_DEFAULT_SELECTION)
  const writeQueue = useRef<Promise<void>>(Promise.resolve())
  const requestId = useRef(0)

  useEffect(() => {
    const bridge = iconBridge()
    if (!bridge) {
      setError("App icon settings are unavailable.")
      setLoaded(true)
      return
    }
    let active = true
    void Promise.all([bridge.get(), bridge.getChannel()])
      .then(([saved, activeChannel]) => {
        if (!active) return
        if (!isAppIconSelection(saved)) throw new Error("The saved app icon choice is invalid.")
        setChannel(activeChannel)
        latestSelection.current = saved
        lastSaved.current = saved
        setSelection(saved)
      })
      .catch((cause: unknown) => {
        if (active)
          setError(cause instanceof Error ? cause.message : "Could not load app icon settings.")
      })
      .finally(() => {
        if (active) setLoaded(true)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!loaded) return
    const bridge = iconBridge()
    if (!bridge) return
    let active = true
    void bridge
      .preview(selection)
      .then((source) => {
        if (active) setPreviewSrc(source)
      })
      .catch((cause: unknown) => {
        if (active)
          setError(cause instanceof Error ? cause.message : "Could not load app icon preview.")
      })
    return () => {
      active = false
    }
  }, [loaded, selection])

  function choose(change: Partial<AppIconSelection>): void {
    const bridge = iconBridge()
    if (!bridge) return
    const next = { ...latestSelection.current, ...change }
    const currentRequest = ++requestId.current
    latestSelection.current = next
    setSelection(next)
    setError(null)
    writeQueue.current = writeQueue.current
      .then(() => bridge.set(next))
      .then((saved) => {
        if (!isAppIconSelection(saved)) throw new Error("The saved app icon choice is invalid.")
        lastSaved.current = saved
        if (requestId.current === currentRequest) {
          latestSelection.current = saved
          setSelection(saved)
        }
      })
      .catch((cause: unknown) => {
        if (requestId.current === currentRequest) {
          latestSelection.current = lastSaved.current
          setSelection(lastSaved.current)
          setError(cause instanceof Error ? cause.message : "Could not update app icon.")
        }
      })
  }

  const family = selection.family
  const palette = family === "joyplot" ? selection.joyplotPalette : selection.piPalette
  const availablePalettes: readonly AppIconPalette[] =
    channel === "alpha" ? ["viridis"] : APP_ICON_PALETTES
  const favoriteIndex = selection.favoriteIcons.findIndex((favorite) =>
    matchesAppIconFavorite(selection, favorite),
  )
  const isFavorite = favoriteIndex >= 0
  const variant = family === "joyplot" ? selection.joyplotStyle : selection.piFont
  const variantLabel = family === "joyplot" ? "Joyplot style" : "Pi font"
  const piFontIds = PI_ICON_FONTS.map((font) => font.id as PiIconFontId)

  function favoriteLabel(favorite: AppIconFavorite): string {
    const size =
      favorite.family === "joyplot" ? (favorite.expanded ? t("Expanded") : t("Regular size")) : ""
    const direction = favorite.reverse ? t("Reversed") : t("Forward")
    const range = favorite.limitVisibleRange ? t("Limited range") : t("Full range")
    if (favorite.family === "joyplot") {
      return `${t("Joyplot")} ${favorite.style} ${JOYPLOT_STYLE_LABELS[favorite.style]} · ${paletteLabel(favorite.palette)} · ${size} · ${direction} · ${range}`
    }
    const font = PI_ICON_FONTS.find((item) => item.id === favorite.font)
    return `${t("Pi Lab")} ${font?.label ?? favorite.font} · ${paletteLabel(favorite.palette)} · ${direction} · ${range}`
  }

  function selectFavorite(index: number): void {
    const favorite = selection.favoriteIcons[index]
    if (favorite) choose(applyAppIconFavorite(selection, favorite))
  }

  function move(direction: -1 | 1): void {
    if (family === "joyplot") {
      choose({ joyplotStyle: cycle(APP_ICON_JOYPLOT_STYLES, selection.joyplotStyle, direction) })
    } else {
      choose({ piFont: cycle(piFontIds, selection.piFont, direction) })
    }
  }

  function arrowDirection(key: string): -1 | 1 | undefined {
    if (key === "ArrowDown") return 1
    if (key === "ArrowUp") return -1
    return undefined
  }

  function chooseArrow<T extends string>(
    event: KeyboardEvent<HTMLSelectElement>,
    options: readonly T[],
    value: T,
    change: (next: T) => Partial<AppIconSelection>,
  ): void {
    const direction = arrowDirection(event.key)
    if (!direction) return
    event.preventDefault()
    choose(change(cycle(options, value, direction)))
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-4" data-testid="settings-app-icon-picker">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-foreground text-sm">{t("App icon")}</span>
        <span className="text-muted-foreground text-xs">
          {t(
            "Choose an icon. Your choice is saved and applied to the running app where supported.",
          )}
        </span>
      </div>

      {loaded ? (
        <>
          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              aria-label={t("Previous icon")}
              data-testid="settings-app-icon-previous"
              disabled={!iconBridge()}
              onClick={() => move(-1)}
              className="rounded-md border border-border p-2 text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <ChevronLeft className="size-5" aria-hidden="true" />
            </button>
            <img
              src={previewSrc}
              alt={`${family === "joyplot" ? "Joyplot" : "Pi Lab"} ${variant}, ${paletteLabel(palette)}${family === "joyplot" ? (selection.joyplotReverse ? ", reversed" : "") : selection.piReverse ? ", reversed" : ""}${family === "joyplot" ? (selection.joyplotLimitVisibleRange ? ", limited visible range" : "") : selection.piLimitVisibleRange ? ", limited visible range" : ""}`}
              width={160}
              height={160}
              data-testid="settings-app-icon-preview"
              className="size-40 rounded-2xl border border-black/10 shadow-sm"
            />
            <button
              type="button"
              aria-label={t("Next icon")}
              data-testid="settings-app-icon-next"
              disabled={!iconBridge()}
              onClick={() => move(1)}
              className="rounded-md border border-border p-2 text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <ChevronRight className="size-5" aria-hidden="true" />
            </button>
          </div>

          <div className="flex min-w-0 items-end gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-foreground">
              <label htmlFor="settings-app-icon-favorites">{t("Favorite icons")}</label>
              <select
                id="settings-app-icon-favorites"
                data-testid="settings-app-icon-favorites"
                value={favoriteIndex < 0 ? "" : String(favoriteIndex)}
                disabled={!iconBridge() || selection.favoriteIcons.length === 0}
                onChange={(event) => {
                  if (event.target.value !== "") selectFavorite(Number(event.target.value))
                }}
                onKeyDown={(event) => {
                  const direction = arrowDirection(event.key)
                  if (!direction || selection.favoriteIcons.length === 0) return
                  event.preventDefault()
                  const options = selection.favoriteIcons.map((_, index) => String(index))
                  const next = cycle(
                    options,
                    favoriteIndex < 0 ? "" : String(favoriteIndex),
                    direction,
                  )
                  selectFavorite(Number(next))
                }}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
              >
                <option value="">{t("Choose a favorite")}</option>
                {selection.favoriteIcons.map((favorite, index) => (
                  <option key={JSON.stringify(favorite)} value={index}>
                    {favoriteLabel(favorite)}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              data-testid="settings-app-icon-favorite"
              aria-label={t(isFavorite ? "Remove from favorites" : "Add to favorites")}
              aria-pressed={isFavorite}
              disabled={!iconBridge()}
              onClick={() =>
                choose({
                  favoriteIcons: isFavorite
                    ? selection.favoriteIcons.filter(
                        (favorite) => !matchesAppIconFavorite(selection, favorite),
                      )
                    : [snapshotAppIconFavorite(selection), ...selection.favoriteIcons],
                })
              }
              className="rounded-md border border-border p-2 text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <Star className={`size-4 ${isFavorite ? "fill-current" : ""}`} aria-hidden="true" />
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="flex min-w-0 flex-col gap-1 text-xs text-foreground">
              {t("Icon family")}
              <select
                data-testid="settings-app-icon-family"
                value={family}
                disabled={!iconBridge()}
                onChange={(event) => choose({ family: event.target.value as AppIconFamily })}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
              >
                <option value="joyplot">{t("Joyplot")}</option>
                <option value="pi">{t("Pi Lab")}</option>
              </select>
            </label>
            <label
              htmlFor="settings-app-icon-variant"
              className="flex min-w-0 flex-col gap-1 text-xs text-foreground"
            >
              {t(variantLabel)}
              {family === "joyplot" ? (
                <select
                  id="settings-app-icon-variant"
                  data-testid="settings-app-icon-style"
                  value={selection.joyplotStyle}
                  disabled={!iconBridge()}
                  onChange={(event) =>
                    choose({ joyplotStyle: event.target.value as JoyplotStyleId })
                  }
                  onKeyDown={(event) =>
                    chooseArrow(event, APP_ICON_JOYPLOT_STYLES, selection.joyplotStyle, (next) => ({
                      joyplotStyle: next,
                    }))
                  }
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                >
                  {APP_ICON_JOYPLOT_STYLES.map((style) => (
                    <option key={style} value={style}>
                      {style} {JOYPLOT_STYLE_LABELS[style]}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  id="settings-app-icon-variant"
                  data-testid="settings-app-icon-font"
                  value={selection.piFont}
                  disabled={!iconBridge()}
                  onChange={(event) => choose({ piFont: event.target.value as PiIconFontId })}
                  onKeyDown={(event) =>
                    chooseArrow(event, piFontIds, selection.piFont, (next) => ({ piFont: next }))
                  }
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                >
                  {PI_ICON_FONTS.map((font) => (
                    <option key={font.id} value={font.id}>
                      {font.label}
                    </option>
                  ))}
                </select>
              )}
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs text-foreground">
              {t("Color theme")}
              <select
                data-testid="settings-app-icon-palette"
                value={palette}
                disabled={!iconBridge() || channel === "alpha"}
                onChange={(event) =>
                  choose(
                    family === "joyplot"
                      ? { joyplotPalette: event.target.value as AppIconPalette }
                      : { piPalette: event.target.value as AppIconPalette },
                  )
                }
                onKeyDown={(event) =>
                  chooseArrow(event, APP_ICON_PALETTES, palette, (next) =>
                    family === "joyplot" ? { joyplotPalette: next } : { piPalette: next },
                  )
                }
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
              >
                {availablePalettes.map((id) => (
                  <option key={id} value={id}>
                    {paletteLabel(id)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            {family === "joyplot" ? (
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  data-testid="settings-app-icon-expanded"
                  checked={selection.joyplotExpanded}
                  disabled={!iconBridge()}
                  onChange={(event) => choose({ joyplotExpanded: event.target.checked })}
                  className="size-4 accent-current"
                />
                {t("Expanded")}
              </label>
            ) : null}
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                data-testid="settings-app-icon-reverse"
                checked={family === "joyplot" ? selection.joyplotReverse : selection.piReverse}
                disabled={!iconBridge()}
                onChange={(event) =>
                  choose(
                    family === "joyplot"
                      ? { joyplotReverse: event.target.checked }
                      : { piReverse: event.target.checked },
                  )
                }
                className="size-4 accent-current"
              />
              {t("Reverse")}
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                data-testid="settings-app-icon-limit-visible-range"
                checked={
                  family === "joyplot"
                    ? selection.joyplotLimitVisibleRange
                    : selection.piLimitVisibleRange
                }
                disabled={!iconBridge()}
                onChange={(event) =>
                  choose(
                    family === "joyplot"
                      ? { joyplotLimitVisibleRange: event.target.checked }
                      : { piLimitVisibleRange: event.target.checked },
                  )
                }
                className="size-4 accent-current"
              />
              {t("Limit visible range")}
            </label>
          </div>
          {error ? (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-muted-foreground text-xs">{t("Loading app icon…")}</p>
      )}
    </div>
  )
}
