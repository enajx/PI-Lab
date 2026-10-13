import { Button, cn } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, Workflow } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { CaffeineControl } from "../../../../../caffeine"
import { useTranslate } from "../../../../../i18n/language"
import { useSidebarCollapsed } from "../../../../../preferences/preferences"
import { QuickFind, type QuickFindItem } from "../../../../../QuickFind"
import { eventMatchesShortcut } from "../../../../../shortcuts/shortcuts"
import { useTRPC } from "../../../../../trpc/react"
import { AgentStatusControl, titleBarControlClass, titleBarHeaderClass } from "../../../titleBar"
import { AutomationRow } from "./components/AutomationRow"
import { AutomationsEmptyState } from "./components/AutomationsEmptyState"
import { CreateAutomationForm } from "./components/CreateAutomationForm"

/**
 * Automations / Workflows view (AGENTS.md "Scope" — scheduled & looping agent runs).
 * Lists every automation (name, cadence summary, next run, enabled toggle),
 * offers a create form, and per-row run-now / enable-disable / delete plus an
 * expandable run history. A workflow can either open an interactive agent
 * terminal or invoke the supported harness in one-shot run-to-completion mode;
 * external communications remain intentionally absent.
 *
 * The body owns its own scroll via a bounded `min-h-0 overflow-y-auto` child
 * (AGENTS.md Pitfalls #3 — never a nested Radix ScrollArea). All assertion-worthy
 * elements carry stable `data-testid`s (md/engineering/testing-and-build.md).
 */
export function AutomationsView({
  activation,
}: {
  activation?: { workflowId: string; runId: string }
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [collapsed] = useSidebarCollapsed()

  const listQuery = useQuery(trpc.automations.list.queryOptions(undefined, { staleTime: 0 }))
  const projectsQuery = useQuery(trpc.projects.list.queryOptions())
  const agentsQuery = useQuery(trpc.agents.list.queryOptions(undefined, { staleTime: 0 }))

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
  const findItems = useMemo<QuickFindItem[]>(
    () =>
      automations.map((automation) => ({
        id: automation.id,
        label: automation.name,
        hint: automation.scheduleSummary,
        icon: Workflow,
      })),
    [automations],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!eventMatchesShortcut(event, "quick-open")) return
      event.preventDefault()
      setFindOpen(true)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  return (
    <div data-testid="automations-view" className="flex h-full w-full flex-col overflow-hidden">
      <header
        className={cn(
          "flex shrink-0 items-center justify-between gap-4 border-border border-b py-3",
          titleBarHeaderClass(collapsed),
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Workflow className="size-4 shrink-0 text-brand" aria-hidden />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h1 className="truncate font-semibold text-foreground text-sm tracking-tight">
              {t("Workflows")}
            </h1>
            <p className="truncate text-muted-foreground text-xs">
              {t("Scheduled & looping agent runs")}
            </p>
          </div>
        </div>
        <div className={cn("flex shrink-0 items-center gap-2", titleBarControlClass(collapsed))}>
          <Button
            data-testid="new-automation"
            size="sm"
            disabled={!canCreate || creating}
            onClick={() => setCreating(true)}
            title={canCreate ? undefined : t("Open a project first")}
            data-feature-help={t(
              "Create a recurring agent run for a project, prompt, and schedule",
            )}
          >
            <Plus aria-hidden />
            {t("New workflow")}
          </Button>
          <AgentStatusControl />
          <CaffeineControl />
        </div>
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
                targetRunId={
                  activation?.workflowId === automation.id ? activation.runId : undefined
                }
              />
            ))}
          </ul>
        )}
      </div>
      {findOpen ? (
        <QuickFind
          ariaLabel={t("Find a workflow")}
          placeholder={t("Find a workflow…")}
          scopeLabel={t("Workflows")}
          allowGlobalSearch
          items={findItems}
          emptyText={t("No matching workflows")}
          onSelect={(item) =>
            document
              .querySelector<HTMLElement>(`[data-automation-id="${item.id}"]`)
              ?.scrollIntoView({
                block: "nearest",
              })
          }
          onClose={() => setFindOpen(false)}
        />
      ) : null}
    </div>
  )
}
