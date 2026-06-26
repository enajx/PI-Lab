import { Button, Input, Label } from "@skipper/ui"
import { useState } from "react"

interface ImportOptionsProps {
  /** Import hosts from the given ssh-config path (empty ⇒ the default ~/.ssh/config). */
  onImport: (path: string | undefined) => void
  onClose: () => void
  isPending?: boolean
}

/**
 * Minimal Cluster settings, folded into the tab (AGENTS.md "Scope" — "keep it small,
 * or fold a couple of options into the tab"): import hosts from a non-default
 * ssh-config path. The full settings route group doesn't exist in this shell
 * yet, so a co-located inline panel is the clean v1 home for the one option that
 * matters — the source config path. A blank path imports from `~/.ssh/config`.
 */
export function ImportOptions({ onImport, onClose, isPending }: ImportOptionsProps) {
  const [path, setPath] = useState("")

  return (
    <div
      data-testid="cluster-import-options"
      className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-4"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ssh-config-path" className="text-muted-foreground text-xs">
          SSH config path
        </Label>
        <Input
          id="ssh-config-path"
          data-testid="ssh-config-path"
          value={path}
          placeholder="~/.ssh/config (default)"
          onChange={(e) => setPath(e.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          Leave blank to import from your default <code className="font-mono">~/.ssh/config</code>.
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          data-testid="import-from-path"
          disabled={isPending}
          onClick={() => onImport(path.trim() || undefined)}
        >
          {isPending ? "Importing…" : "Import"}
        </Button>
      </div>
    </div>
  )
}
