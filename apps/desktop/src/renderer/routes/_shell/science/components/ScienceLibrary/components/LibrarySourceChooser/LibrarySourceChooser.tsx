import { Button } from "@pi-lab/ui"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Cloud, FolderOpen, HardDrive } from "lucide-react"
import { useState } from "react"
import { useTranslate } from "../../../../../../../i18n/language"
import { useTRPC } from "../../../../../../../trpc/react"
import { ZoteroConnectForm, type ZoteroConnectValues } from "../ZoteroConnectForm"

/**
 * The values the chooser forwards to `science.library.connect`: either a Zotero
 * connection (the {@link ZoteroConnectValues} arms) or a local folder of PDFs. This is
 * the renderer mirror of the router's source union.
 */
export type LibrarySourceValues = ZoteroConnectValues | { kind: "folder"; folderPath: string }

interface LibrarySourceChooserProps {
  onConnect: (values: LibrarySourceValues) => void
  isPending?: boolean
  error?: string | null
}

/**
 * First-run source picker for the Library tab. Three co-equal cards — **Zotero local**
 * (the running Zotero desktop API, no key, with a live "detected" probe), **Zotero
 * cloud** (the Web API key), and **Folder** (a local directory of PDFs, for people who
 * don't use Zotero). Zotero local connects zero-config in one click; either Zotero card
 * can expand its form for the full picker; the folder card opens the native directory
 * dialog and connects to the chosen path.
 */
export function LibrarySourceChooser({ onConnect, isPending, error }: LibrarySourceChooserProps) {
  const t = useTranslate()
  const trpc = useTRPC()
  // Live local-reachability hint; short-lived so reopening the tab re-checks, but not
  // hammered (a closed Zotero costs one ~2.5s probe per stale window, not per render).
  const detect = useQuery({
    ...trpc.science.library.detectLocal.queryOptions(),
    staleTime: 15_000,
    retry: false,
  })
  const reachable = detect.data?.reachable ?? false

  // The native folder picker that backs the "Folder" card (parented to the window).
  const pickFolder = useMutation(trpc.system.pickDirectory.mutationOptions())

  // Which mode's full form is expanded below the cards (null = just the cards).
  const [expanded, setExpanded] = useState<"local" | "web" | null>(null)

  const chooseFolder = async () => {
    const folderPath = await pickFolder.mutateAsync()
    if (folderPath) onConnect({ kind: "folder", folderPath })
  }

  return (
    <div
      data-testid="library-source-chooser"
      className="mx-auto flex w-full max-w-3xl flex-col gap-4"
    >
      <div className="flex flex-col items-center gap-1 text-center">
        <h2 className="font-semibold text-foreground text-sm">{t("Choose a library source")}</h2>
        <p className="max-w-md text-muted-foreground text-xs leading-relaxed">
          {t(
            "Connect Zotero locally or through the cloud Web API, or browse a folder of PDFs. You can change this later in Settings.",
          )}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {/* Zotero local card */}
        <div
          data-testid="zotero-chooser-local"
          className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-4"
        >
          <div className="flex items-center gap-2">
            <HardDrive className="size-4 text-muted-foreground" aria-hidden />
            <span className="font-medium text-foreground text-sm">{t("Zotero local")}</span>
            <span
              data-testid="zotero-local-detected"
              data-reachable={reachable}
              className={
                reachable
                  ? "ml-auto rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary"
                  : "ml-auto rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
              }
            >
              {detect.isLoading ? t("Checking…") : reachable ? t("Detected ✓") : t("Not detected")}
            </span>
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {t("The running Zotero desktop app needs no API key and works offline.")}
          </p>
          <div className="mt-auto flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              data-testid="zotero-use-local"
              data-feature-label={t("Use local Zotero")}
              data-feature-help={t(
                "Browse the library in the running Zotero desktop app without an API key.",
              )}
              disabled={isPending}
              onClick={() =>
                onConnect({ kind: "zotero", mode: "local", libraryType: "user", libraryId: "0" })
              }
            >
              {t("Use local Zotero")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="zotero-local-advanced-toggle"
              data-feature-label={t("Local Zotero options")}
              data-feature-help={t("Configure a specific local Zotero user or group library.")}
              className="text-muted-foreground text-xs"
              onClick={() => setExpanded((cur) => (cur === "local" ? null : "local"))}
            >
              {t("Advanced")}
            </Button>
          </div>
        </div>

        {/* Zotero cloud card */}
        <div
          data-testid="zotero-chooser-web"
          className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-4"
        >
          <div className="flex items-center gap-2">
            <Cloud className="size-4 text-muted-foreground" aria-hidden />
            <span className="font-medium text-foreground text-sm">{t("Zotero cloud")}</span>
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {t("Connect with a Zotero API key from")} <code className="font-mono">zotero.org</code>.{" "}
            {t("Works without the desktop app.")}
          </p>
          <div className="mt-auto">
            <Button
              type="button"
              size="sm"
              variant={expanded === "web" ? "secondary" : "default"}
              data-testid="zotero-use-web"
              data-feature-label={t("Connect Zotero cloud")}
              data-feature-help={t("Connect a Zotero library using its cloud Web API credentials.")}
              onClick={() => setExpanded((cur) => (cur === "web" ? null : "web"))}
            >
              {t("Connect with API key")}
            </Button>
          </div>
        </div>

        {/* Local folder card */}
        <div
          data-testid="library-source-folder"
          className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-4"
        >
          <div className="flex items-center gap-2">
            <FolderOpen className="size-4 text-muted-foreground" aria-hidden />
            <span className="font-medium text-foreground text-sm">{t("Folder")}</span>
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {t("Browse a folder of PDFs and its subfolders without Zotero. Read-only.")}
          </p>
          <div className="mt-auto">
            <Button
              type="button"
              size="sm"
              data-testid="library-source-folder-pick"
              data-feature-label={t("Choose PDF folder")}
              data-feature-help={t(
                "Browse a local folder of PDFs as a read-only research library.",
              )}
              disabled={isPending || pickFolder.isPending}
              onClick={() => void chooseFolder()}
            >
              {t("Choose folder…")}
            </Button>
          </div>
        </div>
      </div>

      {expanded === "web" ? (
        <ZoteroConnectForm mode="web" onSubmit={onConnect} isPending={isPending} error={error} />
      ) : expanded === "local" ? (
        <ZoteroConnectForm mode="local" onSubmit={onConnect} isPending={isPending} error={error} />
      ) : error ? (
        <p
          data-testid="library-source-error"
          className="cursor-text select-text text-center text-destructive text-xs"
        >
          {error}
        </p>
      ) : null}
    </div>
  )
}
