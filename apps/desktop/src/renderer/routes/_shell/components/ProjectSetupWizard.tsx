import type { Project } from "@pi-lab/local-db"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { lazy, Suspense, useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { ProjectMarkdownChoice } from "../../../components/ProjectMarkdownChoice"
import { translateKnownError } from "../../../i18n/errors"
import { useInterfaceLanguage, useTranslate } from "../../../i18n/language"
import { useTRPC } from "../../../trpc/react"
import { ProjectDiff } from "./ProjectDiff"

const PlanningTerminal = lazy(async () => ({
  default: (await import("../../../Terminal/Terminal")).Terminal,
}))

/** Basic project definition and isolated CLI draft review after a project is added. */
export function ProjectSetupWizard({
  project,
  optional,
  onDone,
}: {
  project: Project
  optional: boolean
  onDone: (project: Project) => void
}) {
  const t = useTranslate()
  const [language] = useInterfaceLanguage()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [step, setStep] = useState<"offer" | "form" | "running" | "review">(
    optional ? "offer" : "form",
  )
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState("")
  const [customInstructions, setCustomInstructions] = useState("")
  const [customTouched, setCustomTouched] = useState(false)
  const [typeId, setTypeId] = useState(
    project.typeId === "research" ||
      project.typeId === "software" ||
      project.typeId === "manuscript"
      ? project.typeId
      : "",
  )
  const [agentChoice, setAgentChoice] = useState("")
  const [mode, setMode] = useState<"one-shot" | "interactive">("one-shot")
  const [draftId, setDraftId] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [reviewRequested, setReviewRequested] = useState(false)
  const [editedResearch, setEditedResearch] = useState<string | null>(null)
  const settings = useQuery(trpc.settings.get.queryOptions())
  const agents = useQuery(trpc.agents.list.queryOptions())
  const currentProject = useQuery(trpc.projects.get.queryOptions({ id: project.id }))
  const pendingPlans = useQuery({
    ...trpc.projects.pendingPlans.queryOptions({ id: project.id }),
    refetchInterval: (query) =>
      query.state.data?.some((draft) => draft.mode === "one-shot" && draft.state === "running")
        ? 1_000
        : false,
  })
  const planDefaults = useQuery(trpc.projects.getPlanDefaults.queryOptions({ id: project.id }))
  const availableAgent =
    agents.data?.find((agent) => agent.available && agent.oneShot) ??
    agents.data?.find((agent) => agent.available)
  const agentId = agentChoice || availableAgent?.id || ""
  const selectedAgent = agents.data?.find((agent) => agent.id === agentId)
  const start = useMutation(trpc.projects.startPlan.mutationOptions())
  const review = useQuery({
    ...trpc.projects.reviewPlan.queryOptions({ draftId: draftId ?? "" }),
    enabled: draftId !== null && reviewRequested,
    retry: false,
  })
  const apply = useMutation(trpc.projects.applyPlan.mutationOptions())
  const discard = useMutation(trpc.projects.discardPlan.mutationOptions())
  const error =
    pendingPlans.error ?? planDefaults.error ?? start.error ?? apply.error ?? discard.error

  useEffect(() => {
    const pending = pendingPlans.data?.find((draft) => !draftId || draft.draftId === draftId)
    if (!pending || start.isPending) return
    if (!draftId) {
      setDraftId(pending.draftId)
      setSessionId(pending.sessionId)
      setName(pending.name)
      setTypeId(pending.typeId)
      setMode(pending.mode)
      setStep("running")
    }
    if (pending.state !== "running") setReviewRequested(true)
  }, [pendingPlans.data, draftId, start.isPending])

  useEffect(() => {
    if (planDefaults.data && !customTouched) {
      setCustomInstructions(planDefaults.data.customInstructions)
    }
  }, [planDefaults.data, customTouched])

  useEffect(() => {
    if (review.isSuccess && step === "running") setStep("review")
  }, [review.isSuccess, step])

  const finish = (result: Project) => {
    queryClient.removeQueries({ queryKey: trpc.projects.pendingPlans.queryKey({ id: project.id }) })
    void queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.projects.get.queryKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.projects.getPlanDefaults.queryKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.science.tasks.list.queryKey() })
    onDone(result)
  }
  const begin = async () => {
    const result = await start.mutateAsync({
      id: project.id,
      name: name.trim(),
      description: description.trim(),
      typeId,
      customInstructions,
      agentId,
      mode,
    })
    setDraftId(result.draftId)
    setSessionId(result.sessionId)
    setReviewRequested(mode === "one-shot")
    setStep("running")
  }
  const leave = async () => {
    if (draftId) await discard.mutateAsync({ draftId })
    await finish(project)
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
      data-testid="project-setup-wizard"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("Plan this project")}
        className="flex max-h-[90vh] w-[min(56rem,100%)] flex-col gap-4 overflow-y-auto rounded-lg border border-border bg-background p-5 shadow-xl"
      >
        {step === "offer" ? (
          <>
            <h2 className="font-semibold text-lg">{t("Plan this project?")}</h2>
            <p className="text-muted-foreground text-sm">
              {t("Set up the project definition, task file, and agent instructions now.")}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => void finish(project)}
                className="rounded border border-border px-3 py-1.5 text-sm"
              >
                {t("Maybe later")}
              </button>
              <button
                type="button"
                onClick={() => setStep("form")}
                className="rounded bg-primary px-3 py-1.5 text-primary-foreground text-sm"
              >
                {t("Plan this project")}
              </button>
            </div>
          </>
        ) : null}
        {step === "form" ? (
          <>
            <h2 className="font-semibold text-lg">{t("Project setup")}</h2>
            <p className="text-muted-foreground text-sm">
              {t("Give the agent a basic definition. Scientific-question planning comes later.")}
            </p>
            <label className="flex flex-col gap-1 text-sm">
              {t("Project name")}
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="rounded border border-border bg-background px-2 py-1"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("Short description")}
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className="min-h-20 rounded border border-border bg-background px-2 py-1"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("Project type")}
              <select
                value={typeId}
                onChange={(event) => setTypeId(event.target.value)}
                className="rounded border border-border bg-background px-2 py-1"
              >
                <option value="" disabled>
                  {t("Choose project type")}
                </option>
                {(settings.data?.projectTemplate.projectTypes ?? []).map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.id === "research"
                      ? t("Research project")
                      : type.id === "software"
                        ? t("Software project")
                        : type.id === "manuscript"
                          ? t("Manuscript")
                          : type.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="rounded border border-border p-3">
              <p className="mb-2 font-medium text-sm">{t("Task Markdown")}</p>
              <ProjectMarkdownChoice
                projectId={project.id}
                kind="tasks"
                currentPath={currentProject.data?.taskRelPath ?? null}
              />
            </div>
            <label className="flex flex-col gap-1 text-sm">
              {t("Instructions for this project's agents")}
              <textarea
                value={customInstructions}
                onChange={(event) => {
                  setCustomTouched(true)
                  setCustomInstructions(event.target.value)
                }}
                className="min-h-24 rounded border border-border bg-background px-2 py-1"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                {t("CLI agent")}
                <select
                  value={agentId}
                  onChange={(event) => {
                    setAgentChoice(event.target.value)
                    if (!agents.data?.find((agent) => agent.id === event.target.value)?.oneShot) {
                      setMode("interactive")
                    }
                  }}
                  className="rounded border border-border bg-background px-2 py-1"
                >
                  {(agents.data ?? []).map((agent) => (
                    <option key={agent.id} value={agent.id} disabled={!agent.available}>
                      {agent.label}
                      {agent.available ? "" : ` ${t("(not installed)")}`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {t("Draft mode")}
                <select
                  value={mode}
                  onChange={(event) => setMode(event.target.value as "one-shot" | "interactive")}
                  className="rounded border border-border bg-background px-2 py-1"
                >
                  <option value="one-shot" disabled={!selectedAgent?.oneShot}>
                    {t("One-shot draft")}
                  </option>
                  <option value="interactive">{t("Interactive terminal")}</option>
                </select>
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => void finish(project)}
                className="rounded border border-border px-3 py-1.5 text-sm"
              >
                {t("Set up later")}
              </button>
              <button
                type="button"
                disabled={
                  !name.trim() ||
                  !description.trim() ||
                  !typeId ||
                  !currentProject.data?.taskRelPath ||
                  !planDefaults.isSuccess ||
                  !agentId ||
                  (mode === "one-shot" && !selectedAgent?.oneShot) ||
                  start.isPending ||
                  pendingPlans.isPending
                }
                onClick={() => void begin().catch(() => undefined)}
                className="rounded bg-primary px-3 py-1.5 text-primary-foreground text-sm disabled:opacity-50"
              >
                {start.isPending ? t("Drafting…") : t("Draft RESEARCH.md")}
              </button>
            </div>
          </>
        ) : null}
        {step === "running" && sessionId ? (
          <>
            <h2 className="font-semibold text-lg">{t("Planning agent")}</h2>
            <p className="text-muted-foreground text-sm">
              {t(
                "The agent is working in an isolated planning folder. Ask it to write PROPOSED_RESEARCH.md, then review the proposal.",
              )}
            </p>
            <div className="h-72 overflow-hidden rounded border border-border">
              <Suspense fallback={<p>{t("Loading terminal…")}</p>}>
                <PlanningTerminal inputKind="agent" sessionId={sessionId} />
              </Suspense>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => void leave().catch(() => undefined)}
                className="rounded border border-border px-3 py-1.5 text-sm"
              >
                {t("Discard")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setReviewRequested(true)
                  void review.refetch()
                }}
                className="rounded bg-primary px-3 py-1.5 text-primary-foreground text-sm"
              >
                {t("Review proposal")}
              </button>
            </div>
          </>
        ) : null}
        {step === "running" && !sessionId ? (
          <>
            <h2 className="font-semibold text-lg">{t("Reviewing proposal…")}</h2>
            {pendingPlans.data?.find((draft) => draft.draftId === draftId)?.error ? (
              <p role="alert">
                {pendingPlans.data.find((draft) => draft.draftId === draftId)?.error}
              </p>
            ) : null}
            {review.isError ? (
              <button type="button" onClick={() => void leave().catch(() => undefined)}>
                {t("Discard")}
              </button>
            ) : null}
          </>
        ) : null}
        {review.isSuccess && step === "review" ? (
          <>
            <h2 className="font-semibold text-lg">{t("Review project files")}</h2>
            <ProjectDiff
              title="RESEARCH.md"
              original={review.data.researchOriginal}
              proposed={editedResearch ?? review.data.researchProposed}
            />
            <label className="flex flex-col gap-1 text-sm">
              {t("Edit proposed RESEARCH.md")}
              <textarea
                value={editedResearch ?? review.data.researchProposed}
                onChange={(event) => setEditedResearch(event.target.value)}
                className="min-h-32 rounded border border-border bg-background p-2 font-mono text-xs"
              />
            </label>
            <ProjectDiff
              title="AGENTS.md"
              original={review.data.agentsOriginal}
              proposed={review.data.agentsProposed}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={discard.isPending}
                onClick={() => void leave().catch(() => undefined)}
                className="rounded border border-border px-3 py-1.5 text-sm"
              >
                {t("Discard")}
              </button>
              <button
                type="button"
                disabled={apply.isPending}
                onClick={() => {
                  if (draftId)
                    void apply
                      .mutateAsync({
                        draftId,
                        researchContent: editedResearch ?? review.data.researchProposed,
                      })
                      .then(finish)
                      .catch(() => undefined)
                }}
                className="rounded bg-primary px-3 py-1.5 text-primary-foreground text-sm"
              >
                {t("Apply")}
              </button>
            </div>
          </>
        ) : null}
        {review.isError ? (
          <p role="alert" className="text-destructive text-sm">
            {translateKnownError(language, review.error.message)}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {translateKnownError(language, error.message)}
          </p>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
