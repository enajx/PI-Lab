import { CaffeineControl } from "../../../../caffeine"
import { AgentStatusControl } from "./AgentStatusControl"
import { IssueReportControl } from "./IssueReportControl"

/** Issue report, agents and caffeine buttons for every view's top bar, set apart by a short divider. */
export function TitleBarSystemControls() {
  return (
    <>
      <span
        aria-hidden
        data-testid="title-bar-controls-divider"
        className="mx-1 inline-block h-4 w-px shrink-0 bg-border first:hidden"
      />
      <IssueReportControl />
      <AgentStatusControl />
      <CaffeineControl />
    </>
  )
}
