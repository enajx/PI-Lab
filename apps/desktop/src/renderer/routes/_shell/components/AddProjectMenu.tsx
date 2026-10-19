import type { Project } from "@pi-lab/local-db"
import { Button, cn } from "@pi-lab/ui"
import { useMutation, useQuery } from "@tanstack/react-query"
import { FilePlus2, FolderOpen, FolderPlus, GitFork, Plus, X } from "lucide-react"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import { translateKnownError } from "../../../i18n/errors"
import { useInterfaceLanguage, useTranslate } from "../../../i18n/language"
import { useTRPC } from "../../../trpc/react"
import { ProjectSetupWizard } from "./ProjectSetupWizard"

type AddProjectMenuProps =
  | {
      variant: "sidebar"
      collapsed: boolean
      onAdded: (project: Project) => void
    }
  | {
      variant: "dashboard-card"
      onAdded: (project: Project) => void
    }
  | {
      variant: "global"
      open: boolean
      onOpenChange: (open: boolean) => void
      onAdded: (project: Project) => void
    }

/**
 * Shared Add Project chooser for every entry point. It owns the three creation
 * flows, loading state, error surface, and close/reset behavior so Dashboard and
 * Sidebar never drift into separate project-creation experiences.
 */
export function AddProjectMenu(props: AddProjectMenuProps) {
  const t = useTranslate()
  const [language] = useInterfaceLanguage()
  const trpc = useTRPC()
  const [localOpen, setLocalOpen] = useState(false)
  const [setup, setSetup] = useState<{ project: Project; optional: boolean } | null>(null)
  const [mode, setMode] = useState<"menu" | "clone" | "template">("menu")
  const [highlight, setHighlight] = useState(0)
  const [url, setUrl] = useState("")
  const [templateName, setTemplateName] = useState("")
  const [templateParentPath, setTemplateParentPath] = useState("")
  const [templateFiles, setTemplateFiles] = useState<string[]>([])
  const [externalFiles, setExternalFiles] = useState<string[]>([])
  const [templateInitialized, setTemplateInitialized] = useState(false)
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const selectMenuItemRef = useRef<(index: number) => void>(() => {})
  const previewDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const labelId = useId()
  const dashboardCard = props.variant === "dashboard-card"
  const collapsed = props.variant === "sidebar" && props.collapsed
  const global = props.variant === "global"
  const templateDialog = mode === "template"
  const controlledOpen = global ? props.open : null
  const onControlledOpenChange = global ? props.onOpenChange : null
  const open = controlledOpen ?? localOpen
  const setOpen = useCallback(
    (next: boolean): void => {
      if (onControlledOpenChange) {
        onControlledOpenChange(next)
        return
      }
      setLocalOpen(next)
    },
    [onControlledOpenChange],
  )

  const onSuccess = (project: Project, optional: boolean) => {
    setSetup({ project, optional })
    if (!global) setOpen(false)
  }
  const pickDirectory = useMutation(trpc.system.pickDirectory.mutationOptions())
  const openProject = useMutation(
    trpc.projects.open.mutationOptions({ onSuccess: (project) => onSuccess(project, true) }),
  )
  const cloneProject = useMutation(
    trpc.projects.clone.mutationOptions({ onSuccess: (project) => onSuccess(project, true) }),
  )
  const pickFile = useMutation(trpc.system.pickFile.mutationOptions())
  const templateProject = useMutation(
    trpc.projects.createFromTemplate.mutationOptions({
      onSuccess: (project) => onSuccess(project, false),
    }),
  )
  const projectList = useQuery({
    ...trpc.projects.list.queryOptions(),
    enabled: mode === "template",
  })
  const templateList = useQuery({
    ...trpc.template.list.queryOptions(),
    staleTime: 0,
    enabled: mode === "template",
  })
  const settings = useQuery({ ...trpc.settings.get.queryOptions(), enabled: mode === "template" })
  const updateTemplateSettings = useMutation(trpc.settings.updateProjectTemplate.mutationOptions())
  const previewQuery = useQuery({
    ...trpc.template.read.queryOptions({ relPath: previewFilePath ?? "" }),
    staleTime: 0,
    enabled: previewFilePath !== null,
  })

  const pending =
    pickDirectory.isPending ||
    pickFile.isPending ||
    openProject.isPending ||
    cloneProject.isPending ||
    templateProject.isPending ||
    updateTemplateSettings.isPending
  const error =
    pickDirectory.error ??
    pickFile.error ??
    openProject.error ??
    cloneProject.error ??
    templateProject.error ??
    updateTemplateSettings.error

  useEffect(() => {
    if (open) return
    setMode("menu")
    setHighlight(0)
    setUrl("")
    setTemplateName("")
    setTemplateParentPath("")
    setTemplateFiles([])
    setExternalFiles([])
    setTemplateInitialized(false)
    setPreviewFilePath(null)
    pickDirectory.reset()
    pickFile.reset()
    openProject.reset()
    cloneProject.reset()
    templateProject.reset()
  }, [
    open,
    pickDirectory.reset,
    pickFile.reset,
    openProject.reset,
    cloneProject.reset,
    templateProject.reset,
  ])

  useEffect(() => {
    return () => {
      if (previewDelayRef.current) clearTimeout(previewDelayRef.current)
    }
  }, [])

  useEffect(() => {
    if (!open || setup) return
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
      if (!global || mode !== "menu") return
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setHighlight((current) => (current + 1) % 3)
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setHighlight((current) => (current + 2) % 3)
      }
      if (event.key === "Enter") {
        event.preventDefault()
        selectMenuItemRef.current(highlight)
      }
    }
    window.addEventListener("mousedown", onPointerDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("mousedown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [global, highlight, mode, open, setOpen, setup])

  const openFromFolder = () => {
    pickDirectory.mutate(undefined, {
      onSuccess: (path) => {
        if (path) openProject.mutate({ path })
      },
    })
  }
  const submitClone = () => {
    const trimmed = url.trim()
    if (!trimmed) return
    pickDirectory.mutate(undefined, {
      onSuccess: (parentDir) => {
        if (parentDir) cloneProject.mutate({ url: trimmed, parentDir })
      },
    })
  }
  const startFromTemplate = () => {
    setMode("template")
  }
  const defaultTemplateFiles = templateList.data ?? []

  useEffect(() => {
    if (
      mode !== "template" ||
      templateInitialized ||
      !templateList.data ||
      !settings.data ||
      !projectList.data
    ) {
      return
    }
    const configured = settings.data.projectTemplate.initializationMarkdownFiles
    const available = new Set(defaultTemplateFiles.map((file) => file.relPath))
    setTemplateFiles(configured.filter((file) => available.has(file)))
    setTemplateParentPath(
      settings.data.projectTemplate.defaultTemplateParentPath ??
        commonProjectParent(projectList.data) ??
        "",
    )
    setTemplateInitialized(true)
  }, [
    defaultTemplateFiles,
    mode,
    projectList.data,
    settings.data,
    templateInitialized,
    templateList.data,
  ])

  const pickTemplateLocation = () => {
    pickDirectory.mutate(undefined, { onSuccess: (path) => path && setTemplateParentPath(path) })
  }
  const pickTemplateFile = () => {
    pickFile.mutate(undefined, {
      onSuccess: (path) => {
        if (!path) return
        setExternalFiles((current) => (current.includes(path) ? current : [...current, path]))
      },
    })
  }
  const submitTemplate = () => {
    const name = templateName.trim()
    const parentPath = templateParentPath.trim()
    if (!name || !parentPath || /[\\/]/.test(name)) return
    templateProject.mutate({
      targetDir: joinPath(parentPath, name),
      templateFiles,
      externalFiles,
    })
  }
  const saveDefaultTemplateLocation = () => {
    const path = templateParentPath.trim()
    if (!path) return
    updateTemplateSettings.mutate({ defaultTemplateParentPath: path })
  }
  const previewAfterHover = (relPath: string) => {
    if (previewDelayRef.current) clearTimeout(previewDelayRef.current)
    previewDelayRef.current = setTimeout(() => {
      setPreviewFilePath(relPath)
      previewDelayRef.current = null
    }, 1000)
  }
  const cancelHoverPreview = () => {
    if (previewDelayRef.current) clearTimeout(previewDelayRef.current)
    previewDelayRef.current = null
  }
  selectMenuItemRef.current = (index) => {
    if (index === 0) openFromFolder()
    if (index === 1) setMode("clone")
    if (index === 2) startFromTemplate()
  }

  return (
    <div
      ref={rootRef}
      data-testid={dashboardCard ? "new-project-card" : undefined}
      className={cn(
        global
          ? templateDialog
            ? "fixed inset-0 z-50"
            : "fixed top-[12vh] left-1/2 z-50 -translate-x-1/2"
          : "relative",
        dashboardCard && "min-w-0",
      )}
    >
      {dashboardCard ? (
        <button
          type="button"
          data-testid="dashboard-add-project"
          aria-label={t("New project")}
          aria-haspopup="menu"
          aria-expanded={open}
          data-feature-label={t("New project")}
          data-feature-help={t(
            "Open a folder, clone a repository, or create a project from the template",
          )}
          onClick={() => setOpen(!open)}
          className="group flex h-full min-h-0 w-full flex-col items-center justify-center gap-2 rounded-xl border border-border/60 border-dashed bg-muted/15 px-5 text-center text-muted-foreground shadow-sm transition-colors hover:border-border hover:bg-muted/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex size-9 items-center justify-center rounded-full border border-border/60 bg-background/50 transition-colors group-hover:border-border">
            <FolderPlus className="size-4" aria-hidden />
          </span>
          <span className="font-medium text-sm">{t("New project")}</span>
          <span className="text-xs">{t("Open, clone, or start from your template")}</span>
        </button>
      ) : props.variant === "sidebar" ? (
        <Button
          data-testid="add-project"
          variant="ghost"
          size="sm"
          aria-haspopup="menu"
          aria-expanded={open}
          className={cn("w-full text-sm", collapsed ? "justify-center px-0" : "justify-start px-2")}
          title={collapsed ? t("Add project") : undefined}
          data-feature-label={t("Add project")}
          data-feature-help={t(
            "Open a folder, clone a repository, or create a project from the template",
          )}
          onClick={() => setOpen(!open)}
        >
          <FolderPlus aria-hidden />
          {collapsed ? null : t("Add project")}
        </Button>
      ) : null}

      {open && !setup ? (
        <>
          {global || templateDialog ? (
            <button
              type="button"
              aria-label={t("Close New/Add Project")}
              className="fixed inset-0 z-40 bg-black/40"
              onClick={() => setOpen(false)}
            />
          ) : null}
          <div
            data-testid="add-project-menu"
            role="menu"
            aria-labelledby={labelId}
            className={cn(
              "z-50 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl",
              global
                ? templateDialog
                  ? "fixed top-1/2 left-1/2 w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2"
                  : "relative w-[min(36rem,calc(100vw-2rem))]"
                : templateDialog
                  ? "fixed top-1/2 left-1/2 w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2"
                  : dashboardCard
                    ? "top-1/2 left-1/2 w-64 -translate-x-1/2 -translate-y-1/2"
                    : "bottom-11 left-0 w-64",
              !global && !templateDialog && "absolute",
            )}
          >
            {mode !== "template" ? (
              <p id={labelId} className="px-2 py-1 font-medium text-muted-foreground text-xs">
                {t("New/Add Project")}
              </p>
            ) : null}

            {mode === "menu" ? (
              <>
                <MenuItem
                  testId="add-project-folder"
                  icon={FolderOpen}
                  label={t("Open from folder")}
                  description={t("Add an existing local project folder to PI Lab.")}
                  onClick={openFromFolder}
                  disabled={pending}
                  selected={global && highlight === 0}
                />
                <MenuItem
                  testId="add-project-clone"
                  icon={GitFork}
                  label={t("Clone from git repo")}
                  description={t("Clone a Git repository into a folder and add it as a project.")}
                  onClick={() => setMode("clone")}
                  disabled={pending}
                  selected={global && highlight === 1}
                />
                <MenuItem
                  testId="add-project-template"
                  icon={FilePlus2}
                  label={t("Start from template")}
                  description={t("Create a new project folder from PI Lab's configured template.")}
                  onClick={startFromTemplate}
                  disabled={pending}
                  selected={global && highlight === 2}
                />
              </>
            ) : null}

            {mode === "clone" ? (
              <form
                data-testid="add-project-clone-form"
                className="flex flex-col gap-2 p-1.5"
                onSubmit={(event) => {
                  event.preventDefault()
                  submitClone()
                }}
              >
                <label
                  className="font-medium text-muted-foreground text-xs"
                  htmlFor={`${labelId}-url`}
                >
                  {t("Git repository URL")}
                </label>
                <input
                  id={`${labelId}-url`}
                  data-testid="add-project-clone-url"
                  data-feature-label={t("Git repository URL")}
                  data-feature-help={t(
                    "Enter the Git repository to clone into a new local project folder.",
                  )}
                  type="text"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://github.com/owner/repo.git"
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-ring"
                />
                <Button
                  type="submit"
                  size="sm"
                  data-feature-label={t("Choose folder and clone")}
                  data-feature-help={t(
                    "Choose a destination folder, clone the repository, and add it to PI Lab.",
                  )}
                  disabled={pending || url.trim().length === 0}
                >
                  {t("Choose folder & clone")}
                </Button>
              </form>
            ) : null}

            {mode === "template" ? (
              <form
                data-testid="add-project-template-form"
                className="flex max-h-[70vh] w-full flex-col gap-4 overflow-y-auto p-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  submitTemplate()
                }}
              >
                <div>
                  <h2 className="font-semibold text-base">{t("Start from template")}</h2>
                  <p className="mt-1 text-muted-foreground text-xs">
                    {t("Choose the project details and Markdown files to start with.")}
                  </p>
                </div>

                <label className="flex flex-col gap-1.5 text-sm">
                  <span className="font-medium">{t("Project name")}</span>
                  <input
                    data-testid="add-project-template-name"
                    value={templateName}
                    onChange={(event) => setTemplateName(event.target.value)}
                    placeholder={t("My research project")}
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 outline-none focus:border-ring"
                  />
                </label>

                <div className="flex flex-col gap-1.5 text-sm">
                  <span className="font-medium">{t("Location")}</span>
                  <div className="flex gap-2">
                    <input
                      data-testid="add-project-template-location"
                      value={templateParentPath}
                      onChange={(event) => setTemplateParentPath(event.target.value)}
                      placeholder={t("Choose a folder")}
                      className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 outline-none focus:border-ring"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={pickTemplateLocation}
                      disabled={pending}
                    >
                      {t("Choose")}
                    </Button>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="w-fit px-1 text-xs"
                    onClick={saveDefaultTemplateLocation}
                    disabled={pending || templateParentPath.trim().length === 0}
                  >
                    {t("Make this the default location")}
                  </Button>
                </div>

                <div className="flex flex-col gap-1.5 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{t("Files to include")}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-1.5 text-xs"
                      onClick={pickTemplateFile}
                      disabled={pending}
                    >
                      <Plus className="size-3" aria-hidden />
                      {t("Add file")}
                    </Button>
                  </div>
                  <div
                    data-testid="add-project-template-files"
                    className="rounded-md border border-border"
                  >
                    {templateList.isLoading ? (
                      <p className="px-2 py-2 text-muted-foreground text-xs">
                        {t("Loading template files…")}
                      </p>
                    ) : null}
                    {templateFiles.map((relPath) => (
                      <InitializationFileRow
                        key={`template:${relPath}`}
                        name={relPath}
                        onPreviewStart={() => previewAfterHover(relPath)}
                        onPreviewCancel={cancelHoverPreview}
                        onPreview={() => {
                          cancelHoverPreview()
                          setPreviewFilePath(relPath)
                        }}
                        onRemove={() =>
                          setTemplateFiles((current) => current.filter((file) => file !== relPath))
                        }
                      />
                    ))}
                    {externalFiles.map((filePath) => (
                      <InitializationFileRow
                        key={`external:${filePath}`}
                        name={fileName(filePath)}
                        onRemove={() =>
                          setExternalFiles((current) => current.filter((file) => file !== filePath))
                        }
                      />
                    ))}
                    {!templateList.isLoading &&
                    templateFiles.length + externalFiles.length === 0 ? (
                      <p className="px-2 py-2 text-muted-foreground text-xs">
                        {t("No Markdown files selected.")}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="flex justify-end gap-2 border-border border-t pt-3">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setMode("menu")}
                    disabled={pending}
                  >
                    {t("Back")}
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={
                      pending ||
                      templateName.trim().length === 0 ||
                      templateParentPath.trim().length === 0 ||
                      /[\\/]/.test(templateName.trim())
                    }
                  >
                    {t("Create project")}
                  </Button>
                </div>
              </form>
            ) : null}

            {error ? (
              <p
                data-testid="add-project-error"
                className="cursor-text select-text px-2 py-1 text-destructive text-xs leading-relaxed"
              >
                {translateKnownError(language, error.message)}
              </p>
            ) : null}
          </div>
          {previewFilePath ? (
            <div
              data-testid="template-file-preview-overlay"
              className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-6"
              role="dialog"
              aria-modal="true"
              aria-label={`${t("Preview")} ${previewFilePath}`}
              tabIndex={-1}
              onClick={(event) => {
                if (event.target === event.currentTarget) setPreviewFilePath(null)
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") setPreviewFilePath(null)
              }}
            >
              <div className="flex max-h-[75vh] w-[min(48rem,calc(100vw-3rem))] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-xl">
                <div className="flex items-center justify-between gap-3 border-border border-b px-4 py-3">
                  <span className="truncate font-mono text-sm">{previewFilePath}</span>
                  <button
                    type="button"
                    aria-label={t("Close preview")}
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => setPreviewFilePath(null)}
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                </div>
                <pre className="min-h-0 overflow-y-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed">
                  {previewQuery.isLoading
                    ? t("Loading…")
                    : previewQuery.data?.exists
                      ? previewQuery.data.content
                      : t("This template file no longer exists.")}
                </pre>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      {setup ? (
        <ProjectSetupWizard
          project={setup.project}
          optional={setup.optional}
          onDone={(project) => {
            setSetup(null)
            if (global) setOpen(false)
            props.onAdded(project)
          }}
        />
      ) : null}
    </div>
  )
}

function InitializationFileRow({
  name,
  onRemove,
  onPreviewStart,
  onPreviewCancel,
  onPreview,
}: {
  name: string
  onRemove: () => void
  onPreviewStart?: () => void
  onPreviewCancel?: () => void
  onPreview?: () => void
}) {
  const t = useTranslate()
  return (
    <div className="flex items-center gap-2 border-border border-b px-2 py-1.5 text-xs last:border-b-0">
      <button
        type="button"
        className={cn(
          "min-w-0 flex-1 truncate text-left font-mono",
          onPreview && "cursor-pointer hover:text-foreground",
        )}
        onPointerEnter={onPreviewStart}
        onPointerLeave={onPreviewCancel}
        onClick={onPreview}
      >
        {name}
      </button>
      <button
        type="button"
        aria-label={`${t("Remove")} ${name}`}
        className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={(event) => {
          event.stopPropagation()
          onRemove()
        }}
      >
        <X className="size-3" aria-hidden />
      </button>
    </div>
  )
}

function commonProjectParent(projects: Array<Pick<Project, "repoPath">>): string | null {
  if (projects.length === 0) return null
  const parents = projects.map((project) => parentPath(project.repoPath))
  const first = parents[0]
  return first && parents.every((parent) => parent === first) ? first : null
}

function parentPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "")
  const index = normalized.lastIndexOf("/")
  return index > 0 ? normalized.slice(0, index) : ""
}

function joinPath(parent: string, name: string): string {
  return `${parent.replace(/[\\/]+$/, "")}/${name}`
}

function fileName(path: string): string {
  const normalized = path.replace(/\\/g, "/")
  return normalized.slice(normalized.lastIndexOf("/") + 1)
}

function MenuItem({
  testId,
  icon: Icon,
  label,
  description,
  onClick,
  disabled,
  selected,
}: {
  testId: string
  icon: typeof FolderOpen
  label: string
  description: string
  onClick: () => void
  disabled: boolean
  selected: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      data-feature-label={label}
      data-feature-help={description}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50",
        selected && "bg-accent",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}
