import { cn } from "@pi-lab/ui"
import type { ReactNode } from "react"

export const CONTROL_ANIMATION_TREATMENTS = ["steam", "halo", "shimmer"] as const

/** Shared visual treatments for compact controls that need to show live activity. */
export type ControlAnimationTreatment = (typeof CONTROL_ANIMATION_TREATMENTS)[number]

/**
 * Wrap a compact control icon with one of PI Lab's restrained gray activity
 * treatments. The caller owns the meaning of `active`; this component only
 * translates that authoritative state into motion.
 *
 * Inactive treatments are hidden rather than merely paused. The shared CSS also
 * removes every animation under `prefers-reduced-motion: reduce`, leaving a
 * subtle static gray treatment while activity remains true.
 */
export function ControlAnimation({
  active,
  treatment,
  children,
  className,
  testId,
}: {
  active: boolean
  treatment: ControlAnimationTreatment
  children: ReactNode
  className?: string
  testId?: string
}) {
  return (
    <span
      data-testid={testId}
      data-active={active}
      data-treatment={treatment}
      aria-hidden
      className={cn("control-animation", className)}
    >
      <span className="control-animation-effect">
        {treatment === "steam" ? (
          <>
            <span className="control-animation-steam control-animation-steam-a" />
            <span className="control-animation-steam control-animation-steam-b" />
            <span className="control-animation-steam control-animation-steam-c" />
          </>
        ) : null}
        {treatment === "halo" ? <span className="control-animation-halo" /> : null}
        {treatment === "shimmer" ? <span className="control-animation-shimmer" /> : null}
      </span>
      <span className="control-animation-content">{children}</span>
    </span>
  )
}
