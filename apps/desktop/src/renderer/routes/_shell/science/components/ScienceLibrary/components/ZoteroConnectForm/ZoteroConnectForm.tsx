import { Button, Input, Label } from "@skipper/ui"
import { Library } from "lucide-react"
import { useState } from "react"

export interface ZoteroConnectValues {
  apiKey: string
  libraryType: "user" | "group"
  libraryId: string
}

interface ZoteroConnectFormProps {
  onSubmit: (values: ZoteroConnectValues) => void
  /** True while the connect mutation is in flight. */
  isPending?: boolean
  /** Error from a failed connect (e.g. a bad key), shown inline + selectable. */
  error?: string | null
}

/**
 * Connect form for the Library tab (AGENTS.md §1 — Zotero). A plain inline panel
 * (not a Radix dialog) so it renders and is assertable under jsdom (§14). The
 * API key field is `type="password"` so it isn't shoulder-surfed, and is sent
 * only to the local main process — it is stored locally and never logged.
 * `libraryType` uses a native `<select>` (the UI package ships no Select).
 */
export function ZoteroConnectForm({ onSubmit, isPending, error }: ZoteroConnectFormProps) {
  const [apiKey, setApiKey] = useState("")
  const [libraryId, setLibraryId] = useState("")
  const [libraryType, setLibraryType] = useState<"user" | "group">("user")

  const canSubmit = apiKey.trim().length > 0 && libraryId.trim().length > 0 && !isPending

  const submit = () => {
    if (!canSubmit) return
    onSubmit({ apiKey: apiKey.trim(), libraryType, libraryId: libraryId.trim() })
  }

  return (
    <form
      data-testid="zotero-connect"
      className="mx-auto flex w-full max-w-md flex-col gap-4 rounded-lg border border-border bg-card/40 p-6"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-accent">
          <Library className="size-6 text-accent-foreground" aria-hidden />
        </span>
        <h2 className="font-semibold text-foreground text-sm">Connect Zotero</h2>
        <p className="max-w-xs text-muted-foreground text-xs leading-relaxed">
          Create a key at <code className="font-mono">zotero.org/settings/keys</code>. It is stored
          locally only and never leaves your machine.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="zotero-api-key" className="text-muted-foreground text-xs">
          API key<span className="text-destructive"> *</span>
        </Label>
        <Input
          id="zotero-api-key"
          data-testid="zotero-api-key-input"
          type="password"
          autoComplete="off"
          value={apiKey}
          placeholder="Zotero Web API key"
          onChange={(event) => setApiKey(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="zotero-library-id" className="text-muted-foreground text-xs">
          Library ID<span className="text-destructive"> *</span>
        </Label>
        <Input
          id="zotero-library-id"
          data-testid="zotero-library-id-input"
          value={libraryId}
          placeholder="e.g. 123456"
          onChange={(event) => setLibraryId(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="zotero-library-type" className="text-muted-foreground text-xs">
          Library type
        </Label>
        <select
          id="zotero-library-type"
          data-testid="zotero-library-type-select"
          value={libraryType}
          onChange={(event) => setLibraryType(event.target.value as "user" | "group")}
          className="h-9 rounded-md border border-border bg-background px-2 text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="user">User</option>
          <option value="group">Group</option>
        </select>
      </div>

      {error ? (
        <p
          data-testid="zotero-connect-error"
          className="cursor-text select-text text-destructive text-xs"
        >
          {error}
        </p>
      ) : null}

      <Button type="submit" data-testid="zotero-connect-submit" disabled={!canSubmit}>
        {isPending ? "Connecting…" : "Connect"}
      </Button>
    </form>
  )
}
