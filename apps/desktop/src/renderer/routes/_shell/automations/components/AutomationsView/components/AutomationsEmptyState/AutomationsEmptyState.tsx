import { Button } from "@pi-lab/ui"
import { Plus, Workflow } from "lucide-react"
import { useTranslate } from "../../../../../../../i18n/language"

interface AutomationsEmptyStateProps {
  /** Whether a project + agent exist so a workflow can actually be created. */
  canCreate: boolean
  onCreate: () => void
}

/**
 * Empty state for the Workflows view. Explains what automations
 * do and offers the create action — or, when there is no project/agent yet,
 * nudges the user to open a project first (a workflow always targets one).
 */
export function AutomationsEmptyState({ canCreate, onCreate }: AutomationsEmptyStateProps) {
  const t = useTranslate()
  return (
    <div
      data-testid="automations-empty"
      className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center"
    >
      <Workflow className="size-8 text-muted-foreground/40" aria-hidden />
      <p className="font-medium text-foreground text-sm">{t("No workflows yet")}</p>
      <p className="max-w-sm text-muted-foreground text-xs leading-relaxed">
        {t(
          "Workflows run an agent on a project on a schedule — nightly checks, recurring sweeps, or a looping research task.",
        )}
      </p>
      {canCreate ? (
        <Button data-testid="empty-create" size="sm" className="mt-1" onClick={onCreate}>
          <Plus aria-hidden />
          {t("New workflow")}
        </Button>
      ) : (
        <p className="mt-1 text-muted-foreground/70 text-xs">
          {t("Open a project to create one.")}
        </p>
      )}
    </div>
  )
}
