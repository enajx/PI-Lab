import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Settings } from "lucide-react"
import { allEditorThemes, shownEditorThemeId } from "../Editor/components/editorThemes"
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
  useShowStatusBar,
  useSidebarFeatureHelp,
} from "../preferences/preferences"
import {
  APP_ACCENTS,
  APP_THEMES,
  DEFAULT_ACCENT_ID,
  type ResolvedThemeMode,
  useTheme,
} from "../providers/ThemeProvider"
import { useTRPC } from "../trpc/react"
import type { PaletteCommand, PaletteSubmenu } from "./usePaletteCommands"

type Action = (() => void) | (() => Promise<unknown>)
type Setter<T> = ((value: T) => void) | ((value: T) => Promise<unknown>)

/** A direct setting action; failures remain visible in the command palette. */
function action(id: string, label: string, run: Action): PaletteCommand {
  return { id: `settings-${id}`, label, group: "Settings", icon: Settings, run }
}

/** A setting chosen from a sub-list that previews the highlighted choice. */
function picker(id: string, label: string, submenu: PaletteSubmenu): PaletteCommand {
  return { id: `settings-${id}`, label, group: "Settings", icon: Settings, submenu }
}

const MODE_LABELS = { light: "Light", dark: "Dark" } as const

/** A "Choose theme" entry: one theme in one mode. */
function themeChoice(themeId: string, mode: ResolvedThemeMode): string {
  return `${themeId}:${mode}`
}

function parseThemeChoice(value: string): { themeId: string; mode: ResolvedThemeMode } {
  const [themeId, mode] = value.split(":")
  if (!themeId || (mode !== "light" && mode !== "dark")) {
    throw new Error(`Unknown theme choice: ${value}`)
  }
  return { themeId, mode }
}

/** Show the next boolean value in the label before the user changes it. */
function toggle(id: string, label: string, current: boolean, set: Setter<boolean>): PaletteCommand {
  return action(id, `${current ? "Turn off" : "Turn on"} ${label}`, () => set(!current))
}

/**
 * One command per multi-choice setting ("Change <label>"), opening its options as
 * a sub-list with the current value highlighted. `preview` is given only for
 * visual settings that are cheap and safe to show live; others apply on Enter.
 */
function choice<T extends string>(
  id: string,
  label: string,
  options: readonly (readonly [T, string])[],
  current: T,
  set: Setter<T>,
  preview: ((value: T | null) => void) | null,
): PaletteCommand {
  const known = (value: string): T => {
    const option = options.find(([candidate]) => candidate === value)
    if (!option) throw new Error(`Unknown ${label} choice: ${value}`)
    return option[0]
  }
  return picker(id, `Change ${label}`, {
    options,
    current,
    preview: preview && ((value) => preview(value === null ? null : known(value))),
    apply: (value) => set(known(value)),
  })
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
  const [statusBar, setStatusBar] = useShowStatusBar()
  const [featureHelp, setFeatureHelp] = useSidebarFeatureHelp()
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
    toggle("status-bar", "Status bar", statusBar, setStatusBar),
    toggle("feature-help", "Feature help box", featureHelp, setFeatureHelp),
    toggle(
      "quick-editor-autocomplete",
      "Quick Editor word autocomplete",
      autocomplete,
      setAutocomplete,
    ),
    toggle("quick-editor-run-python", "Quick Editor Run Python", runPython, setRunPython),
    choice(
      "quick-editor-markdown-view",
      "Quick Editor Markdown view",
      [
        ["source", "Source"],
        ["render", "Render"],
      ],
      markdown,
      setMarkdown,
      null,
    ),
    choice(
      "digital-rain-density",
      "Digital Rain density",
      [
        ["sparse", "Sparse"],
        ["normal", "Normal"],
        ["dense", "Dense"],
      ],
      density,
      setDensity,
      null,
    ),
    choice(
      "digital-rain-speed",
      "Digital Rain speed",
      [
        ["slow", "Slow"],
        ["normal", "Normal"],
        ["fast", "Fast"],
      ],
      speed,
      setSpeed,
      null,
    ),
    // Switch directly between Light and Dark; System stays in Settings.
    ...(theme.mode === "dark"
      ? []
      : [action("switch-dark-mode", "Switch to Dark mode", () => theme.setMode("dark"))]),
    ...(theme.mode === "light"
      ? []
      : [action("switch-light-mode", "Switch to Light mode", () => theme.setMode("light"))]),
    // Every theme under Light (if it has a light palette) and Dark; each is previewed
    // in that mode with its own saved accent.
    picker("choose-theme", "Choose theme", {
      options: (["light", "dark"] as const).flatMap((mode) =>
        APP_THEMES.filter((value) => value[mode] !== null).map(
          (value) => [themeChoice(value.id, mode), value.label, MODE_LABELS[mode]] as const,
        ),
      ),
      current: themeChoice(theme.themeId, theme.resolvedMode),
      preview: (value) => {
        const choice = value === null ? null : parseThemeChoice(value)
        theme.previewThemeId(choice?.themeId ?? null)
        theme.previewMode(choice?.mode ?? null)
      },
      apply: (value) => {
        const { themeId, mode } = parseThemeChoice(value)
        theme.setThemeId(themeId)
        theme.setMode(mode)
      },
    }),
    picker("choose-theme-accent", "Choose theme accent", {
      options: [
        [DEFAULT_ACCENT_ID, "Theme default"] as const,
        ...APP_ACCENTS.map((value) => [value.id, value.label] as const),
      ],
      current: theme.accentId,
      preview: theme.previewAccentId,
      apply: theme.setAccentId,
    }),
    choice(
      "language",
      "language",
      LANGUAGES.map((value) => [value.code, value.label] as const),
      language,
      setLanguage,
      null,
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
      choice(
        "caffeine-mode",
        "Caffeine mode",
        [
          ["off", "Off"],
          ["on", "On"],
          ["auto", "Auto"],
        ],
        caffeine.mode,
        (mode) => caffeineMode.mutateAsync({ mode }),
        null,
      ),
      choice(
        "caffeine-scope",
        "Caffeine scope",
        [
          ["system-only", "System only"],
          ["system-plus-display", "System and display"],
        ],
        caffeine.scope,
        (scope) => caffeineScope.mutateAsync({ scope }),
        null,
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
    choice(
      "update-channel",
      "update channel",
      [
        ["stable", "Stable"],
        ["beta", "Beta"],
      ],
      settings.publicUpdateChannel,
      (publicUpdateChannel) => general.mutateAsync({ publicUpdateChannel }),
      null,
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
    choice(
      "python-run-destination",
      "Run Python in",
      [
        ["central", "New tab"],
        ["below-editor", "Below editor"],
      ],
      settings.editor.pythonRunDestination,
      (pythonRunDestination) => editor.mutateAsync({ pythonRunDestination }),
      null,
    ),
    choice(
      "editor-theme",
      "editor theme",
      allEditorThemes(settings.editor.customEditorThemes).map(
        (value) => [value.id, value.label] as const,
      ),
      // "default" shows GitHub for the app's mode, so that entry is the current one.
      shownEditorThemeId(
        settings.editor.editorTheme,
        settings.editor.customEditorThemes,
        theme.resolvedMode,
      ),
      (editorTheme) => editor.mutateAsync({ editorTheme }),
      // Preview by changing only the cached settings the editors read; nothing is saved.
      (editorTheme) =>
        cache.setQueryData(trpc.settings.get.queryKey(), (old) =>
          old
            ? {
                ...old,
                editor: { ...old.editor, editorTheme: editorTheme ?? settings.editor.editorTheme },
              }
            : old,
        ),
    ),
    choice(
      "project-config-storage",
      "per-project config storage",
      [
        ["app", "App memory"],
        ["project", ".pi-lab/config.json"],
        ["both", "Both"],
      ],
      settings.agents.projectConfigStorage,
      (projectConfigStorage) => agent.mutateAsync({ projectConfigStorage }),
      null,
    ),
    choice(
      "default-agent",
      "default agent",
      agents.map((value) => [value.id, value.label] as const),
      settings.agents.defaultAgentId ?? "",
      (defaultAgentId) => agent.mutateAsync({ defaultAgentId }),
      null,
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
      choice(
        `notification-${key}-sound`,
        `${label} sound`,
        NOTIFICATION_SOUND_OPTIONS.map((value) => [value.id, value.label] as const),
        settings.notifications[key].sound,
        (sound) => notifications.mutateAsync({ [key]: { sound } }),
        null,
      ),
    )
  }
  return commands
}
