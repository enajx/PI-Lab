import { Button } from "@pi-lab/ui"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { type ReactNode, useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { useTranslate } from "../../i18n/language"
import { useTRPC } from "../../trpc/react"

/** An action that runs a skill linked in Settings → Agents & worktrees. */
export type SkillLinkedAction = "plan-research" | "auto-research"

const LABELS: Record<SkillLinkedAction, string> = {
  "plan-research": "Plan research",
  "auto-research": "Auto-research",
}

/**
 * Whether `action` has a skill linked in Settings, plus the popup to show when it does not.
 * Callers check `linked` before launching; when false they call `showNotLinked()` and render
 * `dialog`. While settings load, `linked` is true so the launch path reports any error itself.
 */
export function useSkillLink(action: SkillLinkedAction): {
  linked: boolean
  showNotLinked: () => void
  dialog: ReactNode
} {
  const trpc = useTRPC()
  const settings = useQuery(trpc.settings.get.queryOptions())
  const [open, setOpen] = useState(false)
  const editor = settings.data?.editor
  const slug = action === "plan-research" ? editor?.planResearchSkill : editor?.autoResearchSkill
  return {
    linked: settings.data === undefined || Boolean(slug),
    showNotLinked: () => setOpen(true),
    dialog: open ? (
      <SkillNotLinkedDialog label={LABELS[action]} onClose={() => setOpen(false)} />
    ) : null,
  }
}

/**
 * Popup for an action with no skill linked: says so and offers to open Settings → Agents &
 * worktrees, where the skill is linked. Closes on Escape, a backdrop click, or Close.
 */
function SkillNotLinkedDialog({ label, onClose }: { label: string; onClose: () => void }) {
  const t = useTranslate()
  const navigate = useNavigate()
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is a click-to-dismiss surface; Escape (bound above) is the keyboard equivalent.
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismissal mirrors Escape, which is already handled.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t(label)}
        data-testid="skill-not-linked-dialog"
        className="flex w-full max-w-[470px] flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xl"
      >
        <div className="border-border border-b px-3 py-2">
          <h2 className="font-medium text-foreground text-sm">{t(label)}</h2>
        </div>
        <p className="px-3 py-3 text-foreground text-sm leading-relaxed">
          {t(
            "{label} is not linked to a skill yet. Link one in Settings → Agents & worktrees.",
          ).replace("{label}", t(label))}
        </p>
        <div className="flex justify-end gap-2 border-border border-t px-3 py-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="skill-not-linked-open-settings"
            onClick={() => {
              onClose()
              void navigate({ to: "/settings", search: { section: "agents" } })
            }}
          >
            {t("Open Settings")}
          </Button>
          <Button type="button" size="sm" onClick={onClose}>
            {t("Close")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
