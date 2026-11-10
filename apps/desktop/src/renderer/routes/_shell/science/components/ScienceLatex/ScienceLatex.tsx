import { DEFAULT_EDITOR_SETTINGS, type EditorSettings } from "@pi-lab/local-db/editor-settings"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"
import { useTranslate } from "../../../../../i18n/language"
import { useLatexEditorProject } from "../../../../../preferences/preferences"
import { useTRPC } from "../../../../../trpc/react"
import { ProjectPicker } from "../ProjectPicker"
import { ScienceTabShell } from "../ScienceTabShell"
import { type FocusSessionRequest, PaperEditor } from "./PaperEditor"
import { type CreatedPaper, PaperSetup } from "./PaperSetup"

/**
 * LaTeX Editor science tab: a project picker at the top (remembers the last
 * project; a project card can open it with a project chosen), then either the
 * setup to choose the project's paper folder or the paper workspace. With a
 * paper folder set, the workspace puts its Sync button next to the picker. `focusSession`
 * focuses one agent tab of the initial project (see the Project Agents box).
 */
export function ScienceLatex({
  initialProjectId,
  focusSession,
}: {
  initialProjectId?: string
  /** An agent session of the initial project to focus, or null. */
  focusSession: FocusSessionRequest | null
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const projectsQuery = useQuery(trpc.projects.list.queryOptions())
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data])
  const [savedProjectId, setSavedProjectId] = useLatexEditorProject()
  const navigate = useNavigate()
  // The picker always wins over a project in the address: it remembers the
  // choice and replaces the address (dropping any agent to focus).
  const chooseProject = (projectId: string): void => {
    setSavedProjectId(projectId)
    void navigate({ to: "/science/latex", search: { projectId }, replace: true })
  }

  // A project chosen from a dashboard card wins and becomes the remembered one.
  useEffect(() => {
    if (initialProjectId) setSavedProjectId(initialProjectId)
  }, [initialProjectId, setSavedProjectId])
  const wanted = initialProjectId ?? savedProjectId
  const selected = projects.find((project) => project.id === wanted) ?? projects[0] ?? null

  const settingsQuery = useQuery(trpc.settings.get.queryOptions())
  const settings: EditorSettings = settingsQuery.data?.editor ?? DEFAULT_EDITOR_SETTINGS
  const updateEditor = useMutation(
    trpc.settings.updateEditor.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() })
      },
    }),
  )
  // The project whose Create paper is running: its setup stays shown until the
  // PDF is built, even if the paper state already has the new paper.
  const [creatingFor, setCreatingFor] = useState<string | null>(null)
  // The paper Create paper just made; its editor shows that build's PDF or failure.
  const [created, setCreated] = useState<CreatedPaper | null>(null)
  // The top bar element the paper workspace puts its Update paper and Sync buttons in.
  const [syncSlot, setSyncSlot] = useState<HTMLElement | null>(null)
  const paper = useQuery({
    ...trpc.paper.get.queryOptions({ projectId: selected?.id ?? "" }),
    enabled: selected !== null,
  })

  return (
    <ScienceTabShell
      title={t("LaTeX Editor")}
      testId="science-latex"
      actions={
        <>
          <ProjectPicker
            testId="latex-project-select"
            label={t("LaTeX Editor project")}
            help={null}
            value={selected?.id ?? ""}
            projects={projects.map((project) => ({ id: project.id, name: project.name }))}
            allLabel={null}
            onChange={chooseProject}
          />
          <div ref={setSyncSlot} data-testid="latex-sync-slot" className="contents" />
        </>
      }
    >
      {updateEditor.isError ? (
        <p role="alert" className="cursor-text select-text px-6 pt-3 text-destructive text-sm">
          {updateEditor.error.message}
        </p>
      ) : null}
      {projectsQuery.isError ? (
        <p role="alert" className="p-6 text-destructive text-sm">
          {projectsQuery.error.message}
        </p>
      ) : !selected ? (
        <p className="p-6 text-muted-foreground text-sm">
          {projectsQuery.isPending ? t("Loading…") : t("No open projects")}
        </p>
      ) : paper.isError ? (
        <p role="alert" className="cursor-text select-text p-6 text-destructive text-sm">
          {paper.error.message}
        </p>
      ) : paper.data === undefined ? null : paper.data.paper &&
        paper.data.workspaceId &&
        creatingFor !== selected.id ? (
        <PaperEditor
          key={paper.data.workspaceId}
          projectId={selected.id}
          projectName={selected.name}
          workspaceId={paper.data.workspaceId}
          paperDir={paper.data.paper.dir}
          displayDir={paper.data.paper.displayDir}
          rootRelPath={paper.data.rootRelPath}
          lastSyncAt={paper.data.paper.lastSyncAt}
          hasRemote={paper.data.paper.remoteUrl !== null}
          syncEnabled={paper.data.paper.syncEnabled}
          outputDir={paper.data.paper.outputDir}
          effectiveOutputDir={paper.data.paper.effectiveOutputDir}
          settings={settings}
          onUpdateEditorSettings={(patch) => updateEditor.mutate(patch)}
          focusSession={selected.id === initialProjectId ? focusSession : null}
          syncSlot={syncSlot}
          createdBuild={
            created && created.workspaceId === paper.data.workspaceId ? created.build : null
          }
        />
      ) : (
        <PaperSetup
          key={selected.id}
          projectId={selected.id}
          autoDetect={paper.data.autoDetect}
          onCreateStart={() => setCreatingFor(selected.id)}
          onCreated={(paper) => {
            setCreatingFor(null)
            setCreated(paper)
          }}
        />
      )}
    </ScienceTabShell>
  )
}
