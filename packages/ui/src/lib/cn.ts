import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

/**
 * Merge class names with Tailwind-aware conflict resolution: `clsx` flattens
 * conditional/array inputs, then `tailwind-merge` collapses competing utilities
 * so the last one wins (e.g. `px-2 px-4` → `px-4`). Used by every variant-driven
 * component in this package.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
