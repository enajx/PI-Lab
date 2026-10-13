import { Button } from "@pi-lab/ui"
import { useMutation } from "@tanstack/react-query"
import { ExternalLink } from "lucide-react"
import { useState } from "react"
import { useTranslate } from "../../../../../../../i18n/language"
import { useTRPC } from "../../../../../../../trpc/react"

interface OpenItemButtonProps {
  /** The folder item's path key (`LibraryPaper.id`, relative to the folder root). */
  path: string
}

/**
 * Per-item "Open" action for the folder library source — hands the item's path key to
 * `science.library.openItem`, which resolves it under the stored folder root (traversal
 * guarded) and opens the PDF with the OS default app. Renders an inline error if the
 * open fails. Only used for the folder source; Zotero items link out via their URL.
 */
export function OpenItemButton({ path }: OpenItemButtonProps) {
  const t = useTranslate()
  const trpc = useTRPC()
  const open = useMutation(trpc.science.library.openItem.mutationOptions())
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setError(null)
    try {
      const result = await open.mutateAsync({ path })
      if (!result.ok) setError(result.message ?? t("Couldn't open the file."))
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Open failed."))
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      {error ? (
        <span
          data-testid="library-item-open-error"
          className="cursor-text select-text text-destructive text-xs"
        >
          {error}
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="library-item-open"
        className="h-7 gap-1.5 text-muted-foreground text-xs"
        disabled={open.isPending}
        onClick={() => void run()}
      >
        <ExternalLink className="size-3.5" />
        {open.isPending ? t("Opening…") : t("Open")}
      </Button>
    </div>
  )
}
