import { cn } from "@pi-lab/ui"
import { useTranslate } from "../../../../i18n/language"
import {
  APP_ACCENTS,
  appThemeSwatch,
  DEFAULT_ACCENT_ID,
  useTheme,
} from "../../../../providers/ThemeProvider"

const ACCENT_BUTTON =
  "flex h-7 items-center gap-1.5 rounded-md border px-2 text-foreground text-xs outline-none transition hover:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring"

/** Theme default, the preset accents, and a custom color; shown above the theme gallery. */
function AccentPicker() {
  const t = useTranslate()
  const { resolvedMode, accentId, setAccentId } = useTheme()
  const custom = accentId.startsWith("#")
  const pressed = (selected: boolean) =>
    selected ? "border-primary ring-1 ring-primary" : "border-border"

  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 flex-col">
        <span className="text-foreground text-sm">{t("Accent")}</span>
        <span className="text-muted-foreground text-xs">
          {t("Colors panel borders, titles, selected items, buttons and code in any theme.")}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5" data-testid="settings-app-accents">
        <button
          type="button"
          aria-pressed={accentId === DEFAULT_ACCENT_ID}
          data-testid="settings-app-accent-default"
          onClick={() => setAccentId(DEFAULT_ACCENT_ID)}
          className={cn(ACCENT_BUTTON, pressed(accentId === DEFAULT_ACCENT_ID))}
        >
          {t("Theme default")}
        </button>
        {APP_ACCENTS.map((accent) => (
          <button
            key={accent.id}
            type="button"
            aria-label={t(accent.label)}
            aria-pressed={accent.id === accentId}
            title={t(accent.label)}
            data-testid={`settings-app-accent-${accent.id}`}
            onClick={() => setAccentId(accent.id)}
            className={cn(ACCENT_BUTTON, pressed(accent.id === accentId))}
          >
            <span
              aria-hidden
              className="size-3.5 rounded-full"
              style={{ backgroundColor: accent[resolvedMode].accent }}
            />
            {t(accent.label)}
          </button>
        ))}
        <label
          className={cn(ACCENT_BUTTON, "cursor-pointer", pressed(custom))}
          title={t("Pick any color as the accent.")}
        >
          <input
            type="color"
            data-testid="settings-app-accent-custom"
            aria-label={t("Custom accent color")}
            value={custom ? accentId : "#888888"}
            onChange={(event) => setAccentId(event.target.value)}
            className="size-4 cursor-pointer border-0 bg-transparent p-0"
          />
          {t("Custom")}
        </label>
      </div>
    </div>
  )
}

export function AppThemeGallery() {
  const t = useTranslate()
  const { resolvedMode, themeId, setThemeId, themes, unavailableTheme } = useTheme()

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex min-w-0 flex-col">
        <span className="text-foreground text-sm">{t("App theme")}</span>
        <span className="text-muted-foreground text-xs">
          {t("Affects PI Lab’s interface; the code editor theme stays separate.")}
        </span>
      </div>
      <AccentPicker />
      {unavailableTheme ? (
        <p
          data-testid="settings-app-theme-unavailable"
          className="rounded-md border border-amber-500/35 bg-amber-500/8 px-3 py-2 text-foreground text-xs"
        >
          {t("Your saved theme is not offered in this release, so PI Lab uses Default:")}{" "}
          {unavailableTheme}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="settings-app-themes">
        {themes.map((theme) => {
          const selected = theme.id === themeId
          return (
            <button
              key={theme.id}
              type="button"
              aria-label={t(theme.label)}
              aria-pressed={selected}
              data-feature-help={selected ? t("The current theme.") : t("Click to use this theme.")}
              data-testid={`settings-app-theme-${theme.id}`}
              onClick={() => setThemeId(theme.id)}
              className={cn(
                "flex min-w-0 flex-col gap-2 rounded-md border bg-background p-2 text-start outline-none transition",
                "hover:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring",
                selected ? "border-primary ring-1 ring-primary" : "border-border",
              )}
            >
              <span className="flex h-7 w-full overflow-hidden rounded border border-black/10">
                {appThemeSwatch(theme, resolvedMode).map((swatch) => (
                  <span
                    key={swatch.id}
                    aria-hidden
                    className="h-full flex-1"
                    style={{ backgroundColor: swatch.color }}
                  />
                ))}
              </span>
              <span className="truncate text-foreground text-xs">{t(theme.label)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
