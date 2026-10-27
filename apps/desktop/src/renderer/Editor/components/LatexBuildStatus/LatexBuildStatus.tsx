import { ChevronUp } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { useTranslate } from "../../../i18n/language"

export interface LatexBuildStatusData {
  message: string
  log: string
}

/** Compact baseline summary with selectable build output opening above the status bar. */
export function LatexBuildStatus({ status }: { status: LatexBuildStatusData }) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const logId = useId()

  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", dismiss)
    document.addEventListener("keydown", dismissOnEscape)
    return () => {
      document.removeEventListener("mousedown", dismiss)
      document.removeEventListener("keydown", dismissOnEscape)
    }
  }, [open])

  return (
    <div ref={rootRef} data-testid="latex-build-status" className="relative min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={logId}
        onClick={() => setOpen((previous) => !previous)}
        className="flex max-w-full items-center gap-1 rounded px-1 transition-colors hover:bg-accent hover:text-foreground"
      >
        <span className="truncate">{t(status.message)}</span>
        <ChevronUp
          className={`size-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {open ? (
        <section
          id={logId}
          data-testid="latex-build-log"
          aria-label={t("LaTeX build log")}
          className="absolute start-0 bottom-full z-30 mb-1 max-h-[min(24rem,70vh)] w-[min(40rem,70vw)] cursor-text select-text overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-popover p-3 font-mono text-popover-foreground text-xs shadow-lg"
        >
          {status.log || t("No build output.")}
        </section>
      ) : null}
    </div>
  )
}
