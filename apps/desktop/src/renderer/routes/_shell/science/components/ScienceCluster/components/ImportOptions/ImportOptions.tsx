import { Button, Input, Label } from "@pi-lab/ui"
import { useState } from "react"
import { useTranslate } from "../../../../../../../i18n/language"

interface ImportOptionsProps {
  /** Import hosts from the given ssh-config path (empty ⇒ the default ~/.ssh/config). */
  onImport: (path: string | undefined) => void
  onClose: () => void
  isPending?: boolean
}

/**
 * Minimal Cluster settings, folded into the tab: import hosts from a non-default
 * ssh-config path. The full settings route group doesn't exist in this shell
 * yet, so a co-located inline panel is the clean v1 home for the one option that
 * matters — the source config path. A blank path imports from `~/.ssh/config`.
 */
export function ImportOptions({ onImport, onClose, isPending }: ImportOptionsProps) {
  const t = useTranslate()
  const [path, setPath] = useState("")

  return (
    <div
      data-testid="cluster-import-options"
      className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-4"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ssh-config-path" className="text-muted-foreground text-xs">
          {t("SSH config path")}
        </Label>
        <Input
          id="ssh-config-path"
          data-testid="ssh-config-path"
          value={path}
          placeholder={`~/.ssh/config (${t("default")})`}
          onChange={(e) => setPath(e.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          {t("Leave blank to import from your default")}{" "}
          <code className="font-mono">~/.ssh/config</code>.
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button
          size="sm"
          data-testid="import-from-path"
          disabled={isPending}
          onClick={() => onImport(path.trim() || undefined)}
        >
          {isPending ? t("Importing…") : t("Import")}
        </Button>
      </div>
    </div>
  )
}
