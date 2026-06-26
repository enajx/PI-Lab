import { DocPanel } from "../DocPanel"

/**
 * Research panel — renders the workspace's `RESEARCH.md` (the canonical distilled
 * project knowledge, AGENTS.md "What Skipper is") as markdown, with a prompt to create one when
 * it's absent. A thin specialization of {@link DocPanel}.
 */
export function ResearchPanel({ workspaceId }: { workspaceId: string }) {
  return (
    <DocPanel
      workspaceId={workspaceId}
      relPath="RESEARCH.md"
      testId="panel-research"
      emptyTitle="No RESEARCH.md yet"
      emptyHint={
        <>
          Add a <code className="font-mono">RESEARCH.md</code> to the project root to see it here.
        </>
      }
    />
  )
}
