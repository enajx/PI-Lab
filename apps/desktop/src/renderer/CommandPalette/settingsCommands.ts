import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Settings } from "lucide-react"
import { allEditorThemes } from "../Editor/components/editorThemes"
import { LANGUAGES, useInterfaceLanguage } from "../i18n/language"
import { NOTIFICATION_SOUND_OPTIONS } from "../notifications/sounds"
import {
  useDigitalRainDensity,
  useDigitalRainSpeed,
  useQuickEditorAutocomplete,
  useQuickEditorMarkdownMode,
  useQuickEditorRunPython,
  useRestoreProjectTabs,
  useShowAnalysisSection,
  useShowClusterSection,
  useShowSkillsPanel,
} from "../preferences/preferences"
import { APP_THEMES, useTheme } from "../providers/ThemeProvider"
import { useTRPC } from "../trpc/react"
import type { PaletteCommand } from "./usePaletteCommands"

type Action = (() => void) | (() => Promise<unknown>)
type Setter<T> = ((value: T) => void) | ((value: T) => Promise<unknown>)

/** A direct setting action; failures remain visible in the command palette. */
function action(id: string, label: string, run: Action): PaletteCommand {
  return { id: `settings-${id}`, label, group: "Settings", icon: Settings, run }
}

/** Show the next boolean value in the label before the user changes it. */
function toggle(id: string, label: string, current: boolean, set: Setter<boolean>): PaletteCommand {
  return action(id, `${current ? "Turn off" : "Turn on"} ${label}`, () => set(!current))
}

/** Enumerate explicit choices so a command never cycles to an unexpected value. */
function choices<T extends string>(
  id: string,
  label: string,
  options: readonly (readonly [T, string])[],
  current: T,
  set: Setter<T>,
): PaletteCommand[] {
  return options.map(([value, name]) => ({
    ...action(`${id}-${value}`, `Set ${label}: ${name}`, () => set(value)),
    hint: value === current ? "Current" : undefined,
  }))
}

/** Direct controls for existing boolean and choice settings; forms stay in Settings. */
export function useDirectSettingsCommands(): PaletteCommand[] {
  const trpc = useTRPC()
  const cache = useQueryClient()
  const settings = useQuery(trpc.settings.get.queryOptions()).data
  const agents = useQuery(trpc.agents.list.queryOptions()).data ?? []
  const login = useQuery(trpc.system.startAtLogin.queryOptions()).data
  const caffeine = useQuery(trpc.caffeine.status.queryOptions()).data
  const refreshSettings = () => cache.invalidateQueries({ queryKey: trpc.settings.get.queryKey() })
  const general = useMutation(
    trpc.settings.updateGeneral.mutationOptions({ onSuccess: refreshSettings }),
  )
  const editor = useMutation(
    trpc.settings.updateEditor.mutationOptions({ onSuccess: refreshSettings }),
  )
  const agent = useMutation(
    trpc.settings.updateAgents.mutationOptions({ onSuccess: refreshSettings }),
  )
  const notifications = useMutation(
    trpc.settings.updateNotifications.mutationOptions({ onSuccess: refreshSettings }),
  )
  const setLogin = useMutation(
    trpc.system.setStartAtLogin.mutationOptions({
      onSuccess: () => cache.invalidateQueries({ queryKey: trpc.system.startAtLogin.queryKey() }),
    }),
  )
  const caffeineMode = useMutation(
    trpc.caffeine.setMode.mutationOptions({
      onSuccess: () => cache.invalidateQueries({ queryKey: trpc.caffeine.status.queryKey() }),
    }),
  )
  const caffeineScope = useMutation(
    trpc.caffeine.setScope.mutationOptions({
      onSuccess: () => cache.invalidateQueries({ queryKey: trpc.caffeine.status.queryKey() }),
    }),
  )
  const [restore, setRestore] = useRestoreProjectTabs()
  const [skills, setSkills] = useShowSkillsPanel()
  const [cluster, setCluster] = useShowClusterSection()
  const [analysis, setAnalysis] = useShowAnalysisSection()
  const [autocomplete, setAutocomplete] = useQuickEditorAutocomplete()
  const [runPython, setRunPython] = useQuickEditorRunPython()
  const [markdown, setMarkdown] = useQuickEditorMarkdownMode()
  const [density, setDensity] = useDigitalRainDensity()
  const [speed, setSpeed] = useDigitalRainSpeed()
  const [language, setLanguage] = useInterfaceLanguage()
  const theme = useTheme()
  const commands: PaletteCommand[] = [
    toggle("restore-project-tabs", "Restore project tabs", restore, setRestore),
    toggle("show-skills", "Skills panel", skills, setSkills),
    toggle("show-cluster-section", "Cluster section", cluster, setCluster),
    toggle("show-analysis-section", "Analysis section", analysis, setAnalysis),
    toggle(
      "quick-editor-autocomplete",
      "Quick Editor word autocomplete",
      autocomplete,
      setAutocomplete,
    ),
    toggle("quick-editor-run-python", "Quick Editor Run Python", runPython, setRunPython),
    ...choices(
      "quick-editor-markdown-view",
      "Quick Editor Markdown view",
      [
        ["source", "Source"],
        ["render", "Render"],
      ],
      markdown,
      setMarkdown,
    ),
    ...choices(
      "digital-rain-density",
      "Digital Rain density",
      [
        ["sparse", "Sparse"],
        ["normal", "Normal"],
        ["dense", "Dense"],
      ],
      density,
      setDensity,
    ),
    ...choices(
      "digital-rain-speed",
      "Digital Rain speed",
      [
        ["slow", "Slow"],
        ["normal", "Normal"],
        ["fast", "Fast"],
      ],
      speed,
      setSpeed,
    ),
    ...choices(
      "theme-mode",
      "theme mode",
      [
        ["light", "Light"],
        ["dark", "Dark"],
        ["system", "System"],
      ],
      theme.mode,
      theme.setMode,
    ),
    ...choices(
      "app-theme",
      "app theme",
      APP_THEMES.map((value) => [value.id, value.label] as const),
      theme.themeId,
      theme.setThemeId,
    ),
    ...choices(
      "language",
      "language",
      LANGUAGES.map((value) => [value.code, value.label] as const),
      language,
      setLanguage,
    ),
  ]
  if (login?.available)
    commands.push(
      toggle("start-at-login", "Start at login", login.enabled, (enabled) =>
        setLogin.mutateAsync({ enabled }),
      ),
    )
  if (caffeine)
    commands.push(
      ...choices(
        "caffeine-mode",
        "Caffeine mode",
        [
          ["off", "Off"],
          ["on", "On"],
          ["auto", "Auto"],
        ],
        caffeine.mode,
        (mode) => caffeineMode.mutateAsync({ mode }),
      ),
      ...choices(
        "caffeine-scope",
        "Caffeine scope",
        [
          ["system-only", "System only"],
          ["system-plus-display", "System and display"],
        ],
        caffeine.scope,
        (scope) => caffeineScope.mutateAsync({ scope }),
      ),
    )
  if (!settings) return commands
  commands.push(
    toggle(
      "keep-running-after-close",
      "Keep running after window closes",
      settings.keepRunningAfterClose,
      (keepRunningAfterClose) => general.mutateAsync({ keepRunningAfterClose }),
    ),
    toggle(
      "worktree-per-agent",
      "New worktree per agent",
      settings.worktreePerAgent,
      (worktreePerAgent) => general.mutateAsync({ worktreePerAgent }),
    ),
    ...choices(
      "update-channel",
      "update channel",
      [
        ["stable", "Stable"],
        ["beta", "Beta"],
      ],
      settings.publicUpdateChannel,
      (publicUpdateChannel) => general.mutateAsync({ publicUpdateChannel }),
    ),
    toggle(
      "editor-diagnostics",
      "Python diagnostics",
      settings.editor.diagnosticsEnabled,
      (diagnosticsEnabled) => editor.mutateAsync({ diagnosticsEnabled }),
    ),
    toggle(
      "editor-show-hidden-files",
      "Show hidden files",
      settings.editor.showHiddenFiles,
      (showHiddenFiles) => editor.mutateAsync({ showHiddenFiles }),
    ),
    toggle(
      "editor-confirm-file-delete",
      "Confirm before deleting files",
      settings.editor.confirmFileDelete,
      (confirmFileDelete) => editor.mutateAsync({ confirmFileDelete }),
    ),
    ...choices(
      "python-run-destination",
      "Run Python in",
      [
        ["central", "New tab"],
        ["below-editor", "Below editor"],
      ],
      settings.editor.pythonRunDestination,
      (pythonRunDestination) => editor.mutateAsync({ pythonRunDestination }),
    ),
    ...choices(
      "editor-theme",
      "editor theme",
      allEditorThemes(settings.editor.customEditorThemes).map(
        (value) => [value.id, value.label] as const,
      ),
      settings.editor.editorTheme,
      (editorTheme) => editor.mutateAsync({ editorTheme }),
    ),
    ...choices(
      "project-config-storage",
      "per-project config storage",
      [
        ["app", "App memory"],
        ["project", ".pi-lab/config.json"],
        ["both", "Both"],
      ],
      settings.agents.projectConfigStorage,
      (projectConfigStorage) => agent.mutateAsync({ projectConfigStorage }),
    ),
    ...choices(
      "default-agent",
      "default agent",
      agents.map((value) => [value.id, value.label] as const),
      settings.agents.defaultAgentId ?? "",
      (defaultAgentId) => agent.mutateAsync({ defaultAgentId }),
    ),
    toggle("notifications-muted", "Mute all notifications", settings.notifications.muted, (muted) =>
      notifications.mutateAsync({ muted }),
    ),
  )
  const events = [
    ["agentInput", "Agent needs input"],
    ["agentTurnCompletion", "Agent finished its turn"],
    ["terminalCompletion", "Terminal command finished"],
    ["workflowStart", "Routine started"],
    ["workflowCompletion", "Routine completed"],
    ["workflowFailure", "Routine failed"],
  ] as const
  for (const [key, label] of events) {
    commands.push(
      toggle(
        `notification-${key}`,
        `${label} notifications`,
        settings.notifications[key].enabled,
        (enabled) => notifications.mutateAsync({ [key]: { enabled } }),
      ),
      ...choices(
        `notification-${key}-sound`,
        `${label} sound`,
        NOTIFICATION_SOUND_OPTIONS.map((value) => [value.id, value.label] as const),
        settings.notifications[key].sound,
        (sound) => notifications.mutateAsync({ [key]: { sound } }),
      ),
    )
  }
  return commands
}
