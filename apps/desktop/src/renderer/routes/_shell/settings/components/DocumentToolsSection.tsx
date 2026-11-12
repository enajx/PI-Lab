import type { DocumentTool } from "../../../../../main/documents/tools"
import {
  DOCUMENT_TOOL_NAMES,
  InstallToolButton,
  useDocumentTools,
} from "../../../../components/DocumentRender/DocumentRender"
import { SettingsSection } from "./SettingsControls"

const TOOLS: readonly DocumentTool[] = ["quarto", "myst"]

/**
 * Settings > Document tools: the quarto and myst (mystmd) commands PI Lab
 * found (path and version), with an Install button for a missing one.
 */
export function DocumentToolsSection() {
  const status = useDocumentTools()
  return (
    <SettingsSection
      testId="settings-section-document-tools"
      title="Document tools"
      description="Quarto and MyST render .qmd and MyST files to HTML from the Render button. PI Lab installs them into its own data folder."
    >
      {status.isPending ? <p className="px-4 py-3 text-sm">Checking document tools…</p> : null}
      {status.error ? (
        <p role="alert" className="px-4 py-3 text-destructive text-sm">
          {status.error.message}
        </p>
      ) : null}
      {status.data
        ? TOOLS.map((tool) => {
            const found = status.data[tool]
            return (
              <div
                key={tool}
                data-testid={`settings-document-tool-${tool}`}
                className="space-y-1 px-4 py-3 text-sm"
              >
                <h3 className="font-medium">{DOCUMENT_TOOL_NAMES[tool]}</h3>
                {found ? (
                  <>
                    <p className="break-all text-muted-foreground text-xs">{found.path}</p>
                    {found.version ? <p>{found.version}</p> : null}
                    {found.error ? (
                      <p role="alert" className="cursor-text select-text text-destructive">
                        {found.error}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <>
                    <p>Not found</p>
                    <InstallToolButton tool={tool} />
                  </>
                )}
              </div>
            )
          })
        : null}
    </SettingsSection>
  )
}
