import { Button } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef } from "react"
import { useTRPC } from "../../../../trpc/react"
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
              label="LaTeX provider"
              value={data.provider}
              options={[
                { value: "bundled", label: "Bundled Tectonic" },
                { value: "system", label: "System LaTeX (PDFLaTeX)" },
              ]}
              onChange={(value) => {
                if (value === "bundled" || value === "system")
                  update.mutate({ latexProvider: value })
              }}
            />
          </fieldset>
          <div className="space-y-1 px-4 py-3 text-sm">
            <h3 className="font-medium">Bundled Tectonic</h3>
            <p>{data.bundled.available ? "Available" : "Unavailable"}</p>
            {data.bundled.version ? <p>{data.bundled.version}</p> : null}
            {data.bundled.path ? (
              <p className="break-all text-muted-foreground text-xs">{data.bundled.path}</p>
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
            <p className="break-all text-muted-foreground text-xs">
              PDFLaTeX: {data.system.pdflatexPath ?? "Not found"}
            </p>
            <p className="break-all text-muted-foreground text-xs">
              latexmk: {data.system.latexmkPath ?? "Not found"}
            </p>
            {data.system.error ? (
              <p role="alert" className="text-destructive">
                {data.system.error}
              </p>
            ) : null}
            <p className="text-muted-foreground text-xs">
              Install PDFLaTeX downloads TinyTeX when clicked. The installation is shared with VS
              Code and your terminal.
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
