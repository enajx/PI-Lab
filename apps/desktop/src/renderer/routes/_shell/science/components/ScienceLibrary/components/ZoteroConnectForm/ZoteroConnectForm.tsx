import { Button, Input, Label } from "@pi-lab/ui"
import { Library } from "lucide-react"
import { useState } from "react"

/**
 * Connect values for either Zotero backend; `mode` discriminates which fields apply. The
 * `kind: "zotero"` tag makes these a subset of the Library source union (the folder source
 * is the other arm), so the chooser can forward them straight to `science.library.connect`.
 */
export type ZoteroConnectValues =
  | {
      kind: "zotero"
      mode: "local"
      libraryType: "user" | "group"
      libraryId: string
      bridgeToken?: string
    }
  | {
      kind: "zotero"
      mode: "web"
      apiKey: string
      libraryType: "user" | "group"
      libraryId: string
    }

interface ZoteroConnectFormProps {
  /** Which backend this form configures — picks the fields and submit copy. */
  mode: "local" | "web"
  onSubmit: (values: ZoteroConnectValues) => void
  /** True while the connect mutation is in flight. */
  isPending?: boolean
  /** Error from a failed connect (e.g. a bad key / unreachable server), shown inline + selectable. */
  error?: string | null
}

/**
 * Connect form for the Library tab (AGENTS.md "Scope" — Zotero). A plain inline panel
 * (not a Radix dialog) so it renders and is assertable under jsdom (md/engineering/testing-and-build.md).
 * In `web` mode it collects an API key (`type="password"`, never logged) + library; in
 * `local` mode the key is gone (the desktop API needs none) and an optional bridge token
 * unlocks file attachment. Both are sent only to the local main process and stored locally.
 * `libraryType` uses a native `<select>` (the UI package ships no Select).
 */
export function ZoteroConnectForm({ mode, onSubmit, isPending, error }: ZoteroConnectFormProps) {
  const [apiKey, setApiKey] = useState("")
  const [libraryId, setLibraryId] = useState(mode === "local" ? "0" : "")
  const [libraryType, setLibraryType] = useState<"user" | "group">("user")
  const [bridgeToken, setBridgeToken] = useState("")

  const canSubmit =
    !isPending &&
    (mode === "local"
      ? libraryId.trim().length > 0
      : apiKey.trim().length > 0 && libraryId.trim().length > 0)

  const submit = () => {
    if (!canSubmit) return
    if (mode === "local") {
      const token = bridgeToken.trim()
      onSubmit({
        kind: "zotero",
        mode: "local",
        libraryType,
        libraryId: libraryId.trim(),
        ...(token ? { bridgeToken: token } : {}),
      })
    } else {
      onSubmit({
        kind: "zotero",
        mode: "web",
        apiKey: apiKey.trim(),
        libraryType,
        libraryId: libraryId.trim(),
      })
    }
  }

  return (
    <form
      data-testid="zotero-connect"
      data-mode={mode}
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
        <h2 className="font-semibold text-foreground text-sm">
          {mode === "web" ? "Connect Zotero (Web API)" : "Local Zotero"}
        </h2>
        <p className="max-w-xs text-muted-foreground text-xs leading-relaxed">
          {mode === "web" ? (
            <>
              Create a key at <code className="font-mono">zotero.org/settings/keys</code>. It is
              stored locally only and never leaves your machine.
            </>
          ) : (
            <>Reads from the running Zotero desktop app — no API key needed.</>
          )}
        </p>
      </div>

      {mode === "web" ? (
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
      ) : null}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="zotero-library-id" className="text-muted-foreground text-xs">
          Library ID<span className="text-destructive"> *</span>
        </Label>
        <Input
          id="zotero-library-id"
          data-testid="zotero-library-id-input"
          value={libraryId}
          placeholder={mode === "local" ? "0 (personal library)" : "e.g. 123456"}
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

      {mode === "local" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="zotero-bridge-token" className="text-muted-foreground text-xs">
            Bridge token{" "}
            <span className="text-muted-foreground/70">(optional — enables attaching files)</span>
          </Label>
          <Input
            id="zotero-bridge-token"
            data-testid="zotero-bridge-token-input"
            type="password"
            autoComplete="off"
            value={bridgeToken}
            placeholder="extensions.zotero.debug-bridge.token"
            onChange={(event) => setBridgeToken(event.target.value)}
          />
          <p className="text-muted-foreground/70 text-xs leading-relaxed">
            In Zotero, open Settings → Advanced → Config Editor, create the string preference{" "}
            <code className="font-mono">extensions.zotero.debug-bridge.token</code>, set a value,
            and paste the same value here. Leave blank to browse without attaching files.
          </p>
        </div>
      ) : null}

      {error ? (
        <p
          data-testid="zotero-connect-error"
          className="cursor-text select-text text-destructive text-xs"
        >
          {error}
        </p>
      ) : null}

      <Button type="submit" data-testid="zotero-connect-submit" disabled={!canSubmit}>
        {isPending ? "Connecting…" : mode === "web" ? "Connect" : "Use local Zotero"}
      </Button>
    </form>
  )
}
