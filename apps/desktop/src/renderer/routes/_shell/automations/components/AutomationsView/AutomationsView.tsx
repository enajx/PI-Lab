import { Button } from "@skipper/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, Workflow } from "lucide-react"
import { useState } from "react"
import { useTRPC } from "../../../../../trpc/react"
import { AutomationRow } from "./components/AutomationRow"
import { AutomationsEmptyState } from "./components/AutomationsEmptyState"
import { CreateAutomationForm } from "./components/CreateAutomationForm"

/**
 * Automations / Workflows view (AGENTS.md §1 — scheduled & looping agent runs).
 * Lists every automation (name, cadence summary, next run, enabled toggle),
 * offers a create form, and per-row run-now / enable-disable / delete plus an
 * expandable run history. v1 is launch-only: an automation fires a fresh agent
 * session on its project on schedule; external-comms reporting is a later add-on
 * and intentionally absent.
 *
 * The body owns its own scroll via a bounded `min-h-0 overflow-y-auto` child
 * (AGENTS.md §12.3 — never a nested Radix ScrollArea). All assertion-worthy
 * elements carry stable `data-testid`s (§14).
 */
export function AutomationsView() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)

  const listQuery = useQuery(trpc.automations.list.queryOptions())
  const projectsQuery = useQuery(trpc.projects.list.queryOptions())
  const agentsQuery = useQuery(trpc.agents.list.queryOptions())

  const invalidateList = () =>
    queryClient.invalidateQueries({ queryKey: trpc.automations.list.queryKey() })

  const create = useMutation(
    trpc.automations.create.mutationOptions({
      onSuccess: () => {
        setCreating(false)
        void invalidateList()
      },
    }),
  )

  const automations = listQuery.data ?? []
  const projects = projectsQuery.data ?? []
  const agents = agentsQuery.data ?? []
  const canCreate = projects.length > 0 && agents.length > 0

  return (
    <div data-testid="automations-view" className="flex h-full w-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between gap-4 border-border border-b px-6 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Workflow className="size-4 shrink-0 text-brand" aria-hidden />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h1 className="truncate font-semibold text-foreground text-sm tracking-tight">
              Workflows
            </h1>
            <p className="truncate text-muted-foreground text-xs">
              Scheduled &amp; looping agent runs
            </p>
          </div>
        </div>
        <Button
          data-testid="new-automation"
          size="sm"
          disabled={!canCreate || creating}
          onClick={() => setCreating(true)}
          title={canCreate ? undefined : "Open a project first"}
        >
          <Plus aria-hidden />
          New workflow
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
        {creating ? (
          <CreateAutomationForm
            projects={projects}
            agents={agents}
            isPending={create.isPending}
            error={create.error?.message ?? null}
            onCancel={() => setCreating(false)}
            onSubmit={(values) => create.mutate(values)}
          />
        ) : null}

        {automations.length === 0 && !creating ? (
          <AutomationsEmptyState canCreate={canCreate} onCreate={() => setCreating(true)} />
        ) : (
          <ul data-testid="automations-list" className="flex flex-col gap-2">
            {automations.map((automation) => (
              <AutomationRow
                key={automation.id}
                automation={automation}
                projectName={projects.find((p) => p.id === automation.projectId)?.name}
                onChanged={() => void invalidateList()}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
