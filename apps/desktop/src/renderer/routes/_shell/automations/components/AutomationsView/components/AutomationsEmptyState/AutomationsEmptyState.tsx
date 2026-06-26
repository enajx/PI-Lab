import { Button } from "@skipper/ui"
import { Plus, Workflow } from "lucide-react"

interface AutomationsEmptyStateProps {
  /** Whether a project + agent exist so a workflow can actually be created. */
  canCreate: boolean
  onCreate: () => void
}

/**
 * Empty state for the Workflows view (AGENTS.md "Scope"). Explains what automations
 * do and offers the create action — or, when there is no project/agent yet,
 * nudges the user to open a project first (a workflow always targets one).
 */
export function AutomationsEmptyState({ canCreate, onCreate }: AutomationsEmptyStateProps) {
  return (
    <div
      data-testid="automations-empty"
      className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center"
    >
      <Workflow className="size-8 text-muted-foreground/40" aria-hidden />
      <p className="font-medium text-foreground text-sm">No workflows yet</p>
      <p className="max-w-sm text-muted-foreground text-xs leading-relaxed">
        Workflows run an agent on a project on a schedule — nightly checks, recurring sweeps, or a
        looping research task.
      </p>
      {canCreate ? (
        <Button data-testid="empty-create" size="sm" className="mt-1" onClick={onCreate}>
          <Plus aria-hidden />
          New workflow
        </Button>
      ) : (
        <p className="mt-1 text-muted-foreground/70 text-xs">Open a project to create one.</p>
      )}
    </div>
  )
}
