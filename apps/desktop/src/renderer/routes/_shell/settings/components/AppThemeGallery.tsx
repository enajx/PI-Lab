import { cn } from "@pi-lab/ui"
import { useTranslate } from "../../../../i18n/language"
import { APP_THEMES, appThemeSwatch, useTheme } from "../../../../providers/ThemeProvider"

export function AppThemeGallery() {
  const t = useTranslate()
  const { resolvedMode, themeId, setThemeId } = useTheme()

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex min-w-0 flex-col">
        <span className="text-foreground text-sm">{t("App theme")}</span>
        <span className="text-muted-foreground text-xs">
          {t("Affects PI Lab’s interface; the code editor theme stays separate.")}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="settings-app-themes">
        {APP_THEMES.map((theme) => {
          const selected = theme.id === themeId
          return (
            <button
              key={theme.id}
              type="button"
              aria-label={t(theme.label)}
              aria-pressed={selected}
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
