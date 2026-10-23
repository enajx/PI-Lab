import { Button, Input, Label } from "@pi-lab/ui"
import { useState } from "react"
import { useTranslate } from "../../../../../../../i18n/language"
import type { AgentOption, ProjectListItem } from "../../../../../../../trpc/types"
import { ScheduleBuilder } from "../ScheduleBuilder"

export interface CreateAutomationValues {
  projectId: string
  agentId: string
  executionMode: "interactive" | "noninteractive"
  name: string
  prompt: string
  recurrenceRule: string
  timezone: string
}

type ProjectOption = Pick<ProjectListItem, "id" | "name">

interface CreateAutomationFormProps {
  projects: ProjectOption[]
  agents: AgentOption[]
  isPending?: boolean
  error?: string | null
  onSubmit: (values: CreateAutomationValues) => void
  onCancel: () => void
}

const DEFAULT_RRULE = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0"

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

export function CreateAutomationForm({
  projects,
  agents,
  isPending,
  error,
  onSubmit,
  onCancel,
}: CreateAutomationFormProps) {
  const t = useTranslate()
  const [name, setName] = useState("")
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "")
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "")
  const [executionMode, setExecutionMode] = useState<"interactive" | "noninteractive">(
    "interactive",
  )
  const [prompt, setPrompt] = useState("")
  const [recurrenceRule, setRecurrenceRule] = useState(DEFAULT_RRULE)
  const [timezone] = useState(localTimezone())

  const canSubmit =
    name.trim().length > 0 &&
    projectId.length > 0 &&
    agentId.length > 0 &&
    recurrenceRule.trim().length > 0

  const submit = () => {
    if (!canSubmit) return
    onSubmit({
      name: name.trim(),
      projectId,
      agentId,
      executionMode,
      prompt: prompt.trim(),
      recurrenceRule: recurrenceRule.trim(),
      timezone,
    })
  }

  return (
    <form
      data-testid="create-automation-form"
      className="flex flex-col gap-4 rounded-lg border border-border bg-card/40 p-5"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="automation-name" className="text-muted-foreground text-xs">
            {t("Name")} <span className="text-destructive">*</span>
          </Label>
          <Input
            id="automation-name"
            data-testid="automation-name-input"
            autoFocus
            value={name}
            placeholder={t("Nightly research sweep")}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="automation-project" className="text-muted-foreground text-xs">
            {t("Project")} <span className="text-destructive">*</span>
          </Label>
          <select
            id="automation-project"
            data-testid="automation-project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="automation-agent" className="text-muted-foreground text-xs">
            {t("Agent")} <span className="text-destructive">*</span>
          </Label>
          <select
            id="automation-agent"
            data-testid="automation-agent"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="automation-execution-mode" className="text-muted-foreground text-xs">
            {t("Execution")}
          </Label>
          <select
            id="automation-execution-mode"
            data-testid="automation-execution-mode"
            value={executionMode}
            onChange={(event) =>
              setExecutionMode(event.target.value as "interactive" | "noninteractive")
            }
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <option value="interactive">{t("Interactive session")}</option>
            <option value="noninteractive">{t("Run to completion")}</option>
          </select>
          <p className="text-muted-foreground text-xs">
            {t(
              "Interactive opens an agent terminal. Run to completion uses the harness one-shot mode and finishes from its exit status.",
            )}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="automation-prompt" className="text-muted-foreground text-xs">
          {t("Prompt")}
        </Label>
        <textarea
          id="automation-prompt"
          data-testid="automation-prompt"
          value={prompt}
          rows={3}
          placeholder={t("What should the agent do each run?")}
          onChange={(e) => setPrompt(e.target.value)}
          className="resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </div>

      <ScheduleBuilder value={recurrenceRule} onChange={setRecurrenceRule} timezone={timezone} />

      {error ? <p className="cursor-text select-text text-destructive text-xs">{error}</p> : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("Cancel")}
        </Button>
        <Button
          type="submit"
          size="sm"
          data-testid="create-automation-submit"
          disabled={isPending || !canSubmit}
        >
          {t("Create routine")}
        </Button>
      </div>
    </form>
  )
}
