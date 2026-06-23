import type { ComponentProps } from "react"
import { cn } from "../../lib/cn"

/**
 * Form label (shadcn/ui style, hand-authored). A plain `<label>` — no Radix
 * dependency — so it works under jsdom. Associate with a control via `htmlFor`.
 */
export function Label({ className, ...props }: ComponentProps<"label">) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: generic primitive; callers associate it with a control via `htmlFor`.
    <label
      data-slot="label"
      className={cn(
        "font-medium text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className,
      )}
      {...props}
    />
  )
}
