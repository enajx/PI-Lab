import type { EditorSettings } from "@skipper/local-db"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import {
  ChartArea,
  FileDiff,
  Files,
  FlaskConical,
  FolderGit2,
  Keyboard,
  LayoutDashboard,
  Library,
  Moon,
  PanelLeft,
  Save,
  Server,
  Settings,
  ShieldCheck,
  Sun,
  WandSparkles,
  Waypoints,
} from "lucide-react"
import type { ComponentType } from "react"
import { DEFAULT_EDITOR_SETTINGS } from "../Editor/hooks/useEditorBuffers"
import {
  useExperimentalV2,
  useShowCodeChanges,
  useShowFilesPanel,
  useSidebarCollapsed,
} from "../preferences/preferences"
import { useTheme } from "../providers/ThemeProvider"
import { useTRPC } from "../trpc/react"

/** A single entry in the ⌘P palette: searchable label + the action it runs. */
export interface PaletteCommand {
  /** Stable id (React key + `data-command-id`). */
  id: string
  /** Primary, fuzzy-searched text. */
  label: string
  /** Secondary muted text shown on the right (e.g. a project's path). */
  hint?: string
  /** Section this belongs to (kept for ordering; not a header in v1). */
  group: "Navigate" | "View" | "Settings" | "Projects"
  icon: ComponentType<{ className?: string }>
  /** Perform the action. The palette closes itself after calling this. */
  run: () => void
}

/** Param-less navigation targets — literal `to`s so TanStack types them precisely. */
const NAV_TARGETS = [
  { id: "dashboard", label: "Go to Dashboard", icon: LayoutDashboard, to: "/" },
  { id: "library", label: "Go to Library", icon: Library, to: "/science/library" },
  { id: "analysis", label: "Go to Analysis", icon: ChartArea, to: "/science/analysis" },
  { id: "cluster", label: "Go to Cluster", icon: Server, to: "/science/cluster" },
  { id: "skills", label: "Go to Skills", icon: FlaskConical, to: "/science/skills" },
  { id: "workflows", label: "Go to Workflows", icon: Waypoints, to: "/automations" },
  { id: "settings", label: "Open Settings", icon: Settings, to: "/settings" },
] as const

/**
 * Builds the live ⌘P command list: param-less navigations, a couple of global view
 * toggles (theme, sidebar), the searchable Settings toggles (editor + project-view
 * preferences, flipped in place), and one entry per opened project (most-recently-opened
 * first, jumping to its project view). Project-scoped actions (open agent/terminal/…)
 * are deliberately excluded in v1 — they live in the project route's local state and
 * need a dispatch seam to be globally runnable.
 */
export function usePaletteCommands(): PaletteCommand[] {
  const navigate = useNavigate()
  const { theme, toggleTheme } = useTheme()
  const [collapsed, setCollapsed] = useSidebarCollapsed()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const projects = useQuery(trpc.projects.list.queryOptions()).data ?? []

  // DB-backed editor settings (read for dynamic labels, written via updateEditor —
  // mirroring the project route: mutate, then invalidate `settings.get`).
  const settingsQuery = useQuery(trpc.settings.get.queryOptions())
  const editor: EditorSettings = settingsQuery.data?.editor ?? DEFAULT_EDITOR_SETTINGS
  const updateEditor = useMutation(
    trpc.settings.updateEditor.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() }),
    }),
  )
  const patchEditor = (next: Partial<EditorSettings>) => updateEditor.mutate(next)

  // Renderer-only (localStorage) preference toggles.
  const [experimentalV2, setExperimentalV2] = useExperimentalV2()
  const [showFilesPanel, setShowFilesPanel] = useShowFilesPanel()
  const [showCodeChanges, setShowCodeChanges] = useShowCodeChanges()

  const navCommands: PaletteCommand[] = NAV_TARGETS.map((target) => ({
    id: `nav-${target.id}`,
    label: target.label,
    group: "Navigate",
    icon: target.icon,
    run: () => void navigate({ to: target.to }),
  }))

  const viewCommands: PaletteCommand[] = [
    {
      id: "toggle-theme",
      label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
      group: "View",
      icon: theme === "dark" ? Sun : Moon,
      run: toggleTheme,
    },
    {
      id: "toggle-sidebar",
      label: collapsed ? "Expand sidebar" : "Collapse sidebar",
      group: "View",
      icon: PanelLeft,
      run: () => setCollapsed(!collapsed),
    },
  ]

  const settingsCommands: PaletteCommand[] = [
    {
      id: "settings-editor-vim",
      label: editor.vim ? "Turn off Vim mode" : "Turn on Vim mode",
      group: "Settings",
      icon: Keyboard,
      run: () => patchEditor({ vim: !editor.vim }),
    },
    {
      id: "settings-editor-autosave",
      label: editor.autosave ? "Turn off editor autosave" : "Turn on editor autosave",
      group: "Settings",
      icon: Save,
      run: () => patchEditor({ autosave: !editor.autosave }),
    },
    {
      id: "settings-editor-format-on-save",
      label: editor.formatOnSave ? "Turn off format on save" : "Turn on format on save",
      group: "Settings",
      icon: WandSparkles,
      run: () => patchEditor({ formatOnSave: !editor.formatOnSave }),
    },
    {
      id: "settings-editor-checker",
      label:
        editor.typeChecker === "ty"
          ? "Switch type checker to pyrefly"
          : "Switch type checker to ty",
      group: "Settings",
      icon: ShieldCheck,
      run: () => patchEditor({ typeChecker: editor.typeChecker === "ty" ? "pyrefly" : "ty" }),
    },
    {
      id: "settings-show-files-panel",
      label: showFilesPanel ? "Hide Files panel" : "Show Files panel",
      group: "Settings",
      icon: Files,
      run: () => setShowFilesPanel(!showFilesPanel),
    },
    {
      id: "settings-show-code-changes",
      label: showCodeChanges ? 'Hide "Code changes" panel' : 'Show "Code changes" panel',
      group: "Settings",
      icon: FileDiff,
      run: () => setShowCodeChanges(!showCodeChanges),
    },
    {
      id: "settings-experimental-v2",
      label: experimentalV2
        ? "Disable experimental v2 features"
        : "Enable experimental v2 features",
      group: "Settings",
      icon: FlaskConical,
      run: () => setExperimentalV2(!experimentalV2),
    },
  ]

  const projectCommands: PaletteCommand[] = projects.map((project) => ({
    id: `project-${project.id}`,
    label: project.name,
    hint: project.repoPath,
    group: "Projects",
    icon: FolderGit2,
    run: () => void navigate({ to: "/projects/$projectId", params: { projectId: project.id } }),
  }))

  return [...navCommands, ...viewCommands, ...settingsCommands, ...projectCommands]
}
