import { DocPanel } from "../DocPanel"

/**
 * TODOs panel — renders the workspace's `TODO.md` as markdown. GFM task-list
 * syntax (`- [ ]` / `- [x]`) is rendered as checkboxes by the markdown renderer
 * (`remark-gfm`), so a plain checklist file reads as a checklist here without a
 * bespoke parser. Empty state when the file is absent.
 */
export function TodosPanel({ workspaceId }: { workspaceId: string }) {
  return (
    <DocPanel
      workspaceId={workspaceId}
      relPath="TODO.md"
      testId="panel-todos"
      emptyTitle="No TODO.md yet"
      emptyHint={
        <>
          Add a <code className="font-mono">TODO.md</code> to the project root to track tasks here.
        </>
      }
    />
  )
}
