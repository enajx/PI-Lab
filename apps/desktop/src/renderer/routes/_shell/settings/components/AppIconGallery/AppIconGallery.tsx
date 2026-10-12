import { cn } from "@pi-lab/ui"
import { APP_ICON_PI_FONT_DEFAULT, useAppIconPiFont } from "../../../../../preferences/preferences"
import { PI_ICON_FONT_IDS, PI_ICON_FONTS, SHIPPED_PI_ICON_FONT_ID } from "./piIconFonts"

/**
 * Settings → Appearance: compare the uppercase Pi treatments side by side.
 *
 * Picking one records the preference and nothing else — the packaged bundle
 * icon, the Dock icon, and notification identity all keep the shipped Avenir
 * Next Medium outline. The caption says so, so a pick never reads as a change
 * that silently failed to apply.
 */
export function AppIconGallery() {
  const [storedFont, setFont] = useAppIconPiFont()
  // A value from a newer/older build (or hand-edited storage) must not leave the
  // grid with nothing selected — fall back to the treatment we actually ship.
  const selectedFont = PI_ICON_FONT_IDS.has(storedFont) ? storedFont : APP_ICON_PI_FONT_DEFAULT

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex min-w-0 flex-col">
        <span className="text-foreground text-sm">App icon</span>
        <span className="text-muted-foreground text-xs">
          Compare uppercase Pi treatments. Choosing one records your pick for comparison; the
          shipped app icon stays Avenir Next — Medium.
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" data-testid="settings-app-icon-fonts">
        {PI_ICON_FONTS.map((font) => {
          const selected = font.id === selectedFont
          return (
            <button
              key={font.id}
              type="button"
              aria-label={font.label}
              aria-pressed={selected}
              data-testid={`settings-app-icon-font-${font.id}`}
              onClick={() => setFont(font.id)}
              className={cn(
                "flex min-w-0 flex-col items-center gap-2 rounded-md border bg-background p-2 text-center outline-none transition",
                "hover:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring",
                selected ? "border-primary ring-1 ring-primary" : "border-border",
              )}
            >
              <img
                src={font.previewUrl}
                alt=""
                aria-hidden
                width={64}
                height={64}
                className="h-16 w-16 rounded-lg border border-black/10"
              />
              {/* Wraps rather than truncates: a clipped face name defeats the
                  side-by-side comparison this gallery exists for. */}
              <span className="w-full text-balance text-foreground text-xs leading-tight">
                {font.label}
              </span>
              {font.id === SHIPPED_PI_ICON_FONT_ID ? (
                <span className="text-muted-foreground text-[10px] uppercase tracking-wide">
                  Shipped
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
