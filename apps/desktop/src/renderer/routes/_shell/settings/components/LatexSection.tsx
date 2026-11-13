import { DEFAULT_EDITOR_SETTINGS } from "@pi-lab/local-db/editor-settings"
import { Button, Input } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { useTRPC } from "../../../../trpc/react"
import { LatexTemplateSettings } from "./LatexTemplateSettings"
import { OverleafCloneSettings } from "./OverleafCloneSettings"
import { OverleafSettings } from "./OverleafSettings"
import { PapersFolderSettings } from "./PapersFolderSettings"
import { SelectField, SettingsSection } from "./SettingsControls"

/** Global compiler preferences and an explicit, shared PDFLaTeX installation. */
export function LatexSection() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const status = useQuery(
    trpc.latex.status.queryOptions(undefined, {
      refetchInterval: (query) => {
        const state = query.state.data?.installation.state
        return state && !["idle", "complete", "failed"].includes(state) ? 500 : false
      },
    }),
  )
  const invalidateStatus = (): void => {
    void queryClient.invalidateQueries({ queryKey: trpc.latex.status.queryKey() })
  }
  const update = useMutation(
    trpc.settings.updateEditor.mutationOptions({
      onSuccess: () => {
        invalidateStatus()
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() })
      },
    }),
  )
  const settings = useQuery(trpc.settings.get.queryOptions())
  const savedOutputDir = (settings.data?.editor ?? DEFAULT_EDITOR_SETTINGS).latexOutputDir
  // The typed folder, or null while it shows the saved value.
  const [outputDraft, setOutputDraft] = useState<string | null>(null)
  const install = useMutation(trpc.latex.install.mutationOptions({ onSuccess: invalidateStatus }))
  const data = status.data
  const installation = data?.installation
  const completed = useRef(false)
  useEffect(() => {
    if (installation?.state !== "complete") {
      completed.current = false
      return
    }
    if (completed.current) return
    completed.current = true
    void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() })
  }, [installation?.state, queryClient, trpc])
  const installing = Boolean(
    installation && !["idle", "complete", "failed"].includes(installation.state),
  )

  return (
    <SettingsSection
      testId="settings-section-latex"
      title="LaTeX"
      description="This choice applies to all projects."
    >
      {status.isPending ? <p className="px-4 py-3 text-sm">Checking LaTeX tools…</p> : null}
      {status.error ? (
        <p role="alert" className="px-4 py-3 text-destructive text-sm">
          {status.error.message}
        </p>
      ) : null}
      {data ? (
        <>
          <fieldset disabled={update.isPending || installing}>
            <SelectField
              testId="settings-latex-provider"
              label="LaTeX compiler"
              value={data.provider}
              options={[
                { value: "auto", label: "Auto (system LaTeX when installed, else Tectonic)" },
                { value: "bundled", label: "Bundled Tectonic" },
                { value: "system", label: "System LaTeX (PDFLaTeX)" },
              ]}
              onChange={(value) => {
                if (value === "auto" || value === "bundled" || value === "system")
                  update.mutate({ latexProvider: value })
              }}
            />
          </fieldset>
          <div className="flex flex-col gap-2 px-4 py-3 text-sm">
            <label htmlFor="settings-latex-output-dir">Build output folder</label>
            <p className="text-muted-foreground text-xs">
              Where builds write the PDF, relative to the main .tex file's folder. Use . to write
              next to the .tex file. A paper can use its own folder in the LaTeX Editor.
            </p>
            <div className="flex items-center gap-2">
              <Input
                id="settings-latex-output-dir"
                data-testid="settings-latex-output-dir"
                value={outputDraft ?? savedOutputDir}
                onChange={(event) => setOutputDraft(event.target.value)}
              />
              <Button
                data-testid="settings-latex-output-dir-save"
                variant="outline"
                size="sm"
                disabled={outputDraft === null || update.isPending}
                onClick={() => {
                  if (outputDraft === null) return
                  update.mutate(
                    { latexOutputDir: outputDraft },
                    { onSuccess: () => setOutputDraft(null) },
                  )
                }}
              >
                Save
              </Button>
            </div>
          </div>
          <div className="space-y-1 px-4 py-3 text-sm">
            <h3 className="font-medium">Bundled Tectonic</h3>
            <p>{data.bundled.available ? "Available" : "Unavailable"}</p>
            {data.bundled.version ? <p>{data.bundled.version}</p> : null}
            {data.bundled.path ? (
              <details className="text-muted-foreground text-xs">
                <summary className="cursor-pointer">Details</summary>
                <p className="mt-2 break-all">{data.bundled.path}</p>
              </details>
            ) : null}
            {data.bundled.error ? (
              <p role="alert" className="text-destructive">
                {data.bundled.error}
              </p>
            ) : null}
          </div>
          <div className="space-y-2 px-4 py-3 text-sm">
            <h3 className="font-medium">System LaTeX (PDFLaTeX)</h3>
            <p>{data.system.available ? "Available" : "Unavailable"}</p>
            {data.system.version ? <p>{data.system.version}</p> : null}
            <details className="text-muted-foreground text-xs">
              <summary className="cursor-pointer">Details</summary>
              <p className="mt-2 break-all">PDFLaTeX: {data.system.pdflatexPath ?? "Not found"}</p>
              <p className="mt-1 break-all">latexmk: {data.system.latexmkPath ?? "Not found"}</p>
            </details>
            {data.system.error ? (
              <p role="alert" className="text-destructive">
                {data.system.error}
              </p>
            ) : null}
            {!data.system.available ? (
              <>
                <p className="text-muted-foreground text-xs">
                  Install PDFLaTeX downloads TinyTeX when clicked. The installation is shared with
                  VS Code and your terminal.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={install.isPending || installing}
                  onClick={() => install.mutate()}
                >
                  Install PDFLaTeX
                </Button>
              </>
            ) : null}
            {installation?.message ? <p role="status">{installation.message}</p> : null}
            {installing ? (
              <progress
                className="w-full"
                aria-label="PDFLaTeX installation"
                max={100}
                value={installation?.progress ?? undefined}
              />
            ) : null}
            {installation?.error ? (
              <p role="alert" className="text-destructive">
                {installation.error}
              </p>
            ) : null}
          </div>
        </>
      ) : null}
      <LatexTemplateSettings />
      <PapersFolderSettings />
      <OverleafSettings />
      <OverleafCloneSettings />
      {update.error ? (
        <p role="alert" className="px-4 py-3 text-destructive text-sm">
          {update.error.message}
        </p>
      ) : null}
      {install.error ? (
        <p role="alert" className="px-4 py-3 text-destructive text-sm">
          {install.error.message}
        </p>
      ) : null}
    </SettingsSection>
  )
}
