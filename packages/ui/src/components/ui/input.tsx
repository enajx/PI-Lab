import type { ComponentProps } from "react"
import { cn } from "../../lib/cn"

/**
 * Text input (shadcn/ui style, hand-authored). A plain `<input>` styled from the
 * theme tokens — no Radix, so it renders and is assertable under jsdom as well as
 * Browser Mode. Kept kebab-case under `components/ui/` per the project structure.
 */
export function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-9 w-full rounded-md border border-border bg-transparent px-3 py-1 text-sm shadow-sm transition-colors",
        "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  )
}
