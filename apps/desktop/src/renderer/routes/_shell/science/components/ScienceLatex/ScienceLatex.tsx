import { DEFAULT_EDITOR_SETTINGS, type EditorSettings } from "@pi-lab/local-db/editor-settings"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo } from "react"
import { useTranslate } from "../../../../../i18n/language"
import { useLatexEditorProject } from "../../../../../preferences/preferences"
import { useTRPC } from "../../../../../trpc/react"
import { ScienceTabShell } from "../ScienceTabShell"
import { PaperEditor } from "./PaperEditor"
import { PaperSetup } from "./PaperSetup"

/**
 * LaTeX Editor science tab: a project picker at the top (remembers the last
 * project; a project card can open it with a project chosen), then either the
 * setup to link the project's paper or the paper workspace.
 */
export function ScienceLatex({ initialProjectId }: { initialProjectId?: string }) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const projectsQuery = useQuery(trpc.projects.list.queryOptions())
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data])
  const [savedProjectId, setSavedProjectId] = useLatexEditorProject()

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
  const paper = useQuery({
    ...trpc.paper.get.queryOptions({ projectId: selected?.id ?? "" }),
    enabled: selected !== null,
  })

  return (
    <ScienceTabShell
      title={t("LaTeX Editor")}
      testId="science-latex"
      actions={
        <select
          data-testid="latex-project-select"
          aria-label={t("LaTeX Editor project")}
          value={selected?.id ?? ""}
          onChange={(event) => setSavedProjectId(event.target.value)}
          className="h-8 max-w-56 rounded-md border border-border bg-background px-2 text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
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
      ) : paper.data === undefined ? null : paper.data.paper && paper.data.workspaceId ? (
        <PaperEditor
          key={paper.data.workspaceId}
          projectId={selected.id}
          projectName={selected.name}
          workspaceId={paper.data.workspaceId}
          rootRelPath={paper.data.rootRelPath}
          lastSyncAt={paper.data.paper.lastSyncAt}
          hasRemote={paper.data.paper.remoteUrl !== null}
          outputDir={paper.data.paper.outputDir}
          effectiveOutputDir={paper.data.paper.effectiveOutputDir}
          settings={settings}
          onUpdateEditorSettings={(patch) => updateEditor.mutate(patch)}
        />
      ) : (
        <PaperSetup key={selected.id} projectId={selected.id} />
      )}
    </ScienceTabShell>
  )
}
