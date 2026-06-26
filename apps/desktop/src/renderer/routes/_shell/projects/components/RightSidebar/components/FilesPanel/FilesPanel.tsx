import { FileTree } from "../../../../../../../Editor/components/FileTree"

/**
 * Files panel — the workspace file tree, moved out of the editor into the right
 * sidebar so the central panel is dedicated to whatever is open. Clicking a file
 * opens it as a tab in the central panel via {@link onOpenFile}.
 */
export function FilesPanel({
  workspaceId,
  onOpenFile,
}: {
  workspaceId: string
  onOpenFile: (relPath: string) => void
}) {
  return (
    <section data-testid="panel-files" className="flex min-h-0 flex-1 flex-col">
      <FileTree workspaceId={workspaceId} onOpenFile={onOpenFile} />
    </section>
  )
}
