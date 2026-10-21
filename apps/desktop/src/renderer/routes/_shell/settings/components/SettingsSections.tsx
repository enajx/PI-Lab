import type {
  AgentSettings,
  NotificationEventSettings,
  NotificationSettings,
  ProjectConfigStorage,
} from "@pi-lab/local-db"
import type { EditorSettings, PythonRunDestination } from "@pi-lab/local-db/editor-settings"
import { DEFAULT_EDITOR_SETTINGS } from "@pi-lab/local-db/editor-settings"
import { Button } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useLayoutEffect, useState } from "react"
import { type CaffeineMode, type CaffeineScope, useCaffeine } from "../../../../caffeine"
import { ProjectMarkdownChoice } from "../../../../components/ProjectMarkdownChoice"
import { ProjectTypeChoice } from "../../../../components/ProjectTypeChoice"
import {
  allEditorThemes,
  DEFAULT_EDITOR_THEME_ID,
} from "../../../../Editor/components/editorThemes"
import {
  type InterfaceLanguage,
  LANGUAGES,
  useInterfaceLanguage,
  useTranslate,
} from "../../../../i18n/language"
import {
  NOTIFICATION_SOUND_OPTIONS,
  type NotificationSoundId,
  playNotificationSound,
} from "../../../../notifications/sounds"
import {
  EDITOR_FONT_DEFAULT_FAMILY,
  EDITOR_FONT_DEFAULT_SIZE,
  EDITOR_FONT_MAX_SIZE,
  EDITOR_FONT_MIN_SIZE,
  useDefaultAgentId,
  useDigitalRainDensity,
  useDigitalRainSpeed,
  useEditorFontFamily,
  useEditorFontSize,
  useExperimentalV2,
  useFetchExperimentsInstructions,
  useRestoreProjectTabs,
  useShowAnalysisSection,
  useShowClusterSection,
  useShowCodeChanges,
  useShowExperimentsSection,
  useShowResearchHeartbeatSection,
  useShowSkillsPanel,
} from "../../../../preferences/preferences"
import { type ThemeMode, useTheme } from "../../../../providers/ThemeProvider"
import {
  bindingFromEvent,
  findShortcutConflict,
  formatBinding,
  SHORTCUTS,
  useShortcutBindings,
} from "../../../../shortcuts/shortcuts"
import { useTRPC } from "../../../../trpc/react"
import { ProjectSetupWizard } from "../../components/ProjectSetupWizard"
import { LibrarySourceChooser } from "../../science/components/ScienceLibrary/components/LibrarySourceChooser"
import { AppIconGallery } from "./AppIconGallery"
import { AppThemeGallery } from "./AppThemeGallery"
import { SelectField, SettingsSection, TextAreaField, ToggleField } from "./SettingsControls"

const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  muted: false,
  agentInput: { enabled: true, sound: "chime" },
  agentTurnCompletion: { enabled: true, sound: "success" },
  terminalCompletion: { enabled: true, sound: "success" },
  workflowStart: { enabled: false, sound: "pulse" },
  workflowCompletion: { enabled: true, sound: "success" },
  workflowFailure: { enabled: true, sound: "alert" },
}

/** General — app-wide behavior (DB-backed via `settings.updateGeneral`). The default
 *  Settings landing (⌘,). */
export function GeneralSection() {
  const t = useTranslate()
  const [language, setLanguage] = useInterfaceLanguage()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const settingsQuery = useQuery(trpc.settings.get.queryOptions())
  const startAtLoginQuery = useQuery(trpc.system.startAtLogin.queryOptions())
  const updateGeneral = useMutation(
    trpc.settings.updateGeneral.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() }),
    }),
  )
  const setStartAtLogin = useMutation(
    trpc.system.setStartAtLogin.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.system.startAtLogin.queryKey() }),
    }),
  )
  const confirmOnQuit = settingsQuery.data?.confirmOnQuit ?? true
  const keepRunningAfterClose = settingsQuery.data?.keepRunningAfterClose ?? true
  const publicUpdateChannel = settingsQuery.data?.publicUpdateChannel ?? "stable"
  const [restoreProjectTabs, setRestoreProjectTabs] = useRestoreProjectTabs()

  return (
    <SettingsSection
      testId="settings-section-general"
      title="General"
      description="App-wide behavior."
    >
      <SelectField
        testId="settings-interface-language"
        label="Language"
        description="Choose the language used by PI Lab."
        value={language}
        options={LANGUAGES.map((item) => ({ value: item.code, label: item.label }))}
        onChange={(next) => setLanguage(next as InterfaceLanguage)}
      />
      <SelectField
        testId="settings-update-channel"
        label="Update channel"
        description="Choose Stable or Beta for the public PI Lab app. Restart PI Lab after changing channels. Local development builds do not auto-update."
        value={publicUpdateChannel}
        options={[
          { value: "stable", label: "Stable" },
          { value: "beta", label: "Beta" },
        ]}
        onChange={(next) =>
          updateGeneral.mutate({ publicUpdateChannel: next as "stable" | "beta" })
        }
      />
      <ToggleField
        testId="settings-keep-running-after-close"
        label="Keep running after window closes"
        description="Keep PI Lab available in the menu bar or system tray for quick file opens."
        checked={keepRunningAfterClose}
        onChange={(value) => updateGeneral.mutate({ keepRunningAfterClose: value })}
      />
      <ToggleField
        testId="settings-start-at-login"
        label="Start at login"
        description="Launch PI Lab in the background when you sign in."
        checked={startAtLoginQuery.data?.enabled ?? false}
        disabled={startAtLoginQuery.data?.available === false || setStartAtLogin.isPending}
        onChange={(value) => setStartAtLogin.mutate({ enabled: value })}
      />
      {startAtLoginQuery.data?.available === false ? (
        <p className="px-4 py-3 text-muted-foreground text-xs">
          {t("Start at login is available in packaged desktop builds.")}
        </p>
      ) : null}
      {updateGeneral.error || setStartAtLogin.error || startAtLoginQuery.error ? (
        <p role="alert" className="px-4 py-3 text-destructive text-xs">
          {String(updateGeneral.error ?? setStartAtLogin.error ?? startAtLoginQuery.error)}
        </p>
      ) : null}
      <ToggleField
        testId="settings-confirm-quit"
        label="Confirm on quit"
        description="Ask before quitting while agents are running."
        checked={confirmOnQuit}
        onChange={(value) => updateGeneral.mutate({ confirmOnQuit: value })}
      />
      <ToggleField
        testId="settings-restore-project-tabs"
        label="Restore project tabs"
        description="Reopen files and restore terminal and agent tabs when PI Lab relaunches."
        checked={restoreProjectTabs}
        onChange={setRestoreProjectTabs}
      />
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <div>
          <p className="text-sm">{t("First-launch setup")}</p>
          <p className="text-muted-foreground text-xs">
            {t("Recheck harnesses and local integrations or change initial preferences.")}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="settings-run-setup"
          onClick={() => {
            window.location.hash = "#/setup"
          }}
        >
          {t("Run setup again")}
        </Button>
      </div>
    </SettingsSection>
  )
}

/** Appearance — independent whole-app palette and light/dark/system mode. */
export function AppearanceSection() {
  const t = useTranslate()
  const { mode, setMode } = useTheme()
  const trpc = useTRPC()
  const fontsQuery = useQuery(trpc.system.fonts.queryOptions())
  const [fontFamily, setFontFamily] = useEditorFontFamily()
  const [fontSize, setFontSize] = useEditorFontSize()
  const [digitalRainDensity, setDigitalRainDensity] = useDigitalRainDensity()
  const [digitalRainSpeed, setDigitalRainSpeed] = useDigitalRainSpeed()
  const detectedFamilies = fontsQuery.data?.families ?? []
  const familyOptions = [
    { value: EDITOR_FONT_DEFAULT_FAMILY, label: "System monospace (default)" },
    ...(fontFamily !== EDITOR_FONT_DEFAULT_FAMILY && !detectedFamilies.includes(fontFamily)
      ? [{ value: fontFamily, label: `${fontFamily} (currently unavailable)` }]
      : []),
    ...detectedFamilies.map((family) => ({ value: family, label: family })),
  ]
  const fontError =
    fontsQuery.data?.error ??
    (fontsQuery.error
      ? "System fonts could not be detected. The default monospace font is still available."
      : null)

  return (
    <SettingsSection
      testId="settings-section-appearance"
      title="Appearance"
      description="How PI Lab looks."
    >
      <SelectField
        testId="settings-theme-mode"
        label="Theme mode"
        description="Use a light, dark, or system-matched interface."
        value={mode}
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
          { value: "system", label: "System" },
        ]}
        onChange={(value) => setMode(value as ThemeMode)}
      />
      <AppThemeGallery />
      <AppIconGallery />
      <div
        id="appearance-advanced"
        data-testid="appearance-advanced-editor-typography"
        className="flex flex-col gap-1 px-4 py-3"
      >
        <h3 className="font-medium text-sm">{t("Advanced")}</h3>
        <p className="text-muted-foreground text-xs">
          {t("These controls apply globally across PI Lab.")}
        </p>
      </div>
      <SelectField
        testId="settings-editor-font-family"
        label="Editor font family"
        description={
          fontsQuery.isPending
            ? "Detecting fonts installed on this system…"
            : "System-installed fonts."
        }
        value={fontFamily}
        options={familyOptions}
        onChange={setFontFamily}
      />
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <div className="flex min-w-0 flex-col">
          <label htmlFor="settings-editor-font-size" className="text-foreground text-sm">
            {t("Editor font size")}
          </label>
          <span className="text-muted-foreground text-xs">
            {EDITOR_FONT_MIN_SIZE}–{EDITOR_FONT_MAX_SIZE} {t("pixels.")}
          </span>
        </div>
        <input
          id="settings-editor-font-size"
          data-testid="settings-editor-font-size"
          type="number"
          min={EDITOR_FONT_MIN_SIZE}
          max={EDITOR_FONT_MAX_SIZE}
          step={1}
          value={fontSize}
          onChange={(event) => setFontSize(Number(event.target.value))}
          className="w-20 rounded-md border border-border bg-background px-2 py-1 text-foreground text-sm outline-none"
        />
      </div>
      {fontError ? (
        <p
          role="alert"
          data-testid="settings-editor-font-error"
          className="px-4 py-3 text-amber-700 text-xs dark:text-amber-300"
        >
          {fontError}
        </p>
      ) : null}
      <div className="flex justify-end px-4 py-3">
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="settings-editor-font-reset"
          onClick={() => {
            setFontFamily(EDITOR_FONT_DEFAULT_FAMILY)
            setFontSize(EDITOR_FONT_DEFAULT_SIZE)
          }}
        >
          {t("Reset editor typography")}
        </Button>
      </div>
      <div className="border-border border-t px-4 pt-3">
        <h4 className="font-medium text-sm">{t("Digital Rain thumbnails")}</h4>
        <p className="mt-1 text-muted-foreground text-xs">
          {t(
            "Black-and-white ASCII rain uses freshly sampled project files every time PI Lab launches.",
          )}
        </p>
      </div>
      <SelectField
        testId="settings-digital-rain-density"
        label="Digital Rain density"
        description="Caps the number of visible streams in every Digital Rain thumbnail."
        value={digitalRainDensity}
        options={[
          { value: "sparse", label: "Sparse" },
          { value: "normal", label: "Normal" },
          { value: "dense", label: "Dense" },
        ]}
        onChange={(value) => setDigitalRainDensity(value as typeof digitalRainDensity)}
      />
      <SelectField
        testId="settings-digital-rain-speed"
        label="Digital Rain speed"
        description="Sets the low-frequency animation rate for every Digital Rain thumbnail."
        value={digitalRainSpeed}
        options={[
          { value: "slow", label: "Slow" },
          { value: "normal", label: "Normal" },
          { value: "fast", label: "Fast" },
        ]}
        onChange={(value) => setDigitalRainSpeed(value as typeof digitalRainSpeed)}
      />
    </SettingsSection>
  )
}

/** Editor preferences persisted in the DB, including the in-editor gear controls. */
export function EditorSection() {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const settingsQuery = useQuery(trpc.settings.get.queryOptions())
  const editor: EditorSettings = settingsQuery.data?.editor ?? DEFAULT_EDITOR_SETTINGS
  const customEditorThemes = editor.customEditorThemes ?? []
  const pythonRunDestination = editor.pythonRunDestination ?? "central"
  const update = useMutation(
    trpc.settings.updateEditor.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() }),
    }),
  )
  const importThemes = useMutation(trpc.system.importEditorThemes.mutationOptions())
  const [themeErrors, setThemeErrors] = useState<string[]>([])
  const [persistenceError, setPersistenceError] = useState("")
  const patch = (next: Partial<EditorSettings>) => {
    setPersistenceError("")
    update.mutate(next, {
      onError: (error) => setPersistenceError(error.message),
    })
  }
  const themes = allEditorThemes(customEditorThemes)

  const importCustomThemes = async () => {
    setThemeErrors([])
    const result = await importThemes.mutateAsync()
    const byId = new Map(customEditorThemes.map((theme) => [theme.id, theme]))
    for (const theme of result.themes) byId.set(theme.id, theme)
    if (result.themes.length > 0) {
      setPersistenceError("")
      await update
        .mutateAsync({
          customEditorThemes: [...byId.values()],
          editorTheme: result.themes[0]?.id ?? editor.editorTheme,
        })
        .catch((error: Error) => {
          setPersistenceError(error.message)
        })
    }
    setThemeErrors(result.errors.map((error) => `${error.filename}: ${error.message}`))
  }

  const removeCustomTheme = (id: string) => {
    patch({
      customEditorThemes: customEditorThemes.filter((theme) => theme.id !== id),
      ...(editor.editorTheme === id ? { editorTheme: DEFAULT_EDITOR_THEME_ID } : {}),
    })
  }

  return (
    <SettingsSection
      testId="settings-section-editor"
      title="Editor"
      description="Built-in editor behaviour."
    >
      <ToggleField
        testId="settings-editor-autosave"
        label="Autosave"
        description="Save on a short delay instead of ⌘S."
        checked={editor.autosave}
        onChange={(value) => patch({ autosave: value })}
      />
      <ToggleField
        testId="settings-editor-vim"
        label="Vim mode"
        description="CodeMirror Vim keymap."
        checked={editor.vim}
        onChange={(value) => patch({ vim: value })}
      />
      <ToggleField
        testId="settings-editor-diagnostics"
        label="Python diagnostics"
        description="Type-check and lint open Python files."
        checked={editor.diagnosticsEnabled}
        onChange={(value) => patch({ diagnosticsEnabled: value })}
      />
      <ToggleField
        testId="settings-editor-format-on-save"
        label="Format on save"
        description="Run ruff format on ⌘S."
        checked={editor.formatOnSave}
        onChange={(value) => patch({ formatOnSave: value })}
      />
      <SelectField
        testId="settings-editor-checker"
        label="Type checker"
        description="Python type checker for diagnostics."
        value={editor.typeChecker}
        options={[
          { value: "ty", label: "ty" },
          { value: "pyrefly", label: "pyrefly" },
        ]}
        onChange={(value) => patch({ typeChecker: value as EditorSettings["typeChecker"] })}
      />
      <SelectField
        testId="settings-python-run-destination"
        label="Run Python in"
        description="Default destination for the Run button."
        value={pythonRunDestination}
        options={[
          { value: "central", label: "New tab" },
          { value: "below-editor", label: "Below editor" },
        ]}
        onChange={(value) => patch({ pythonRunDestination: value as PythonRunDestination })}
      />
      <SelectField
        testId="settings-editor-theme"
        label="Editor theme"
        description="Color theme for the code editor."
        value={
          themes.some((theme) => theme.id === editor.editorTheme)
            ? (editor.editorTheme ?? DEFAULT_EDITOR_THEME_ID)
            : DEFAULT_EDITOR_THEME_ID
        }
        groups={[
          {
            label: "Light",
            options: themes
              .filter((theme) => theme.mode === "light")
              .map((theme) => ({
                value: theme.id,
                label: theme.label,
              })),
          },
          {
            label: "Dark",
            options: themes
              .filter((theme) => theme.mode === "dark")
              .map((theme) => ({
                value: theme.id,
                label: theme.label,
              })),
          },
        ]}
        onChange={(value) => patch({ editorTheme: value })}
      />
      <div className="flex flex-col gap-3 px-4 py-3" data-testid="settings-editor-theme-gallery">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <span className="text-foreground text-sm">{t("Custom themes")}</span>
            <span className="text-muted-foreground text-xs">
              {t("Import one or more VS Code JSON color themes.")}
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="settings-import-editor-themes"
            disabled={importThemes.isPending}
            onClick={() => void importCustomThemes()}
          >
            {t("Import themes…")}
          </Button>
        </div>
        {customEditorThemes.length > 0 ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {customEditorThemes.map((theme) => (
              <div
                key={theme.id}
                data-testid="settings-custom-editor-theme"
                className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-2"
                style={{
                  background: theme.colors.background,
                  color: theme.colors.foreground,
                }}
              >
                <button
                  type="button"
                  className="truncate text-left text-xs"
                  aria-pressed={editor.editorTheme === theme.id}
                  onClick={() => patch({ editorTheme: theme.id })}
                >
                  {theme.name}
                </button>
                <button
                  type="button"
                  data-testid={`settings-remove-editor-theme-${theme.id}`}
                  className="self-start text-[10px] opacity-75 hover:opacity-100"
                  onClick={() => removeCustomTheme(theme.id)}
                >
                  {t("Remove")}
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {themeErrors.length > 0 || importThemes.error || persistenceError ? (
          <div data-testid="settings-editor-theme-errors" className="text-destructive text-xs">
            {[
              ...themeErrors,
              ...(importThemes.error ? [importThemes.error.message] : []),
              ...(persistenceError ? [persistenceError] : []),
            ].map((error) => (
              <p key={error}>{error}</p>
            ))}
          </div>
        ) : null}
      </div>
    </SettingsSection>
  )
}

/** Agents & worktrees — default agent + the session/quit policies (DB-backed). */
export function AgentsSection() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const agentsQuery = useQuery(trpc.agents.list.queryOptions(undefined, { staleTime: 0 }))
  const settingsQuery = useQuery(trpc.settings.get.queryOptions())
  const [defaultAgent, setDefaultAgent] = useDefaultAgentId()
  const updateGeneral = useMutation(
    trpc.settings.updateGeneral.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() }),
    }),
  )
  const updateAgents = useMutation(
    trpc.settings.updateAgents.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() })
        void queryClient.invalidateQueries({ queryKey: trpc.agents.list.queryKey() })
      },
    }),
  )

  const agents = agentsQuery.data ?? []
  const worktreePerAgent = settingsQuery.data?.worktreePerAgent ?? false
  const agentSettings: AgentSettings = settingsQuery.data?.agents ?? {
    projectConfigStorage: "app",
    executableOverrides: {},
    setupCompleted: false,
  }

  return (
    <SettingsSection
      testId="settings-section-agents"
      title="Agents & worktrees"
      description="Defaults for launching external CLI agents."
    >
      <SelectField
        testId="settings-default-agent"
        label="Default agent"
        description="Used when you open an agent in a project."
        value={defaultAgent}
        options={agents.map((agent) => ({ value: agent.id, label: agent.label }))}
        onChange={setDefaultAgent}
      />
      <ToggleField
        testId="settings-worktree-per-agent"
        label="New worktree per agent"
        description="Always isolate each agent in its own git worktree."
        checked={worktreePerAgent}
        onChange={(value) => updateGeneral.mutate({ worktreePerAgent: value })}
      />
      <SelectField
        testId="settings-project-config-storage"
        label="Per-project config storage"
        description="Keep project launch choices in app memory, .pi-lab/config.json, or both."
        value={agentSettings.projectConfigStorage}
        options={[
          { value: "app", label: "App memory" },
          { value: "project", label: ".pi-lab/config.json" },
          { value: "both", label: "Both (project file wins)" },
        ]}
        onChange={(value) =>
          updateAgents.mutate({ projectConfigStorage: value as ProjectConfigStorage })
        }
      />
      <div className="divide-y divide-border">
        {agents.map((agent) => (
          <AgentExecutableField
            key={`${agent.id}:${agentSettings.executableOverrides[agent.id] ?? ""}`}
            agent={agent}
            configured={agentSettings.executableOverrides[agent.id] ?? ""}
            onSave={(value) => {
              const next = { ...agentSettings.executableOverrides }
              if (value) next[agent.id] = value
              else delete next[agent.id]
              updateAgents.mutate({ executableOverrides: next })
            }}
          />
        ))}
      </div>
      {updateAgents.error ? (
        <p data-testid="settings-agents-error" className="px-4 text-destructive text-xs">
          {updateAgents.error.message}
        </p>
      ) : null}
    </SettingsSection>
  )
}

function AgentExecutableField({
  agent,
  configured,
  onSave,
}: {
  agent: { id: string; label: string; available: boolean; executable: string }
  configured: string
  onSave: (value: string) => void
}) {
  const t = useTranslate()
  const [value, setValue] = useState(configured)
  return (
    <label className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="min-w-0">
        <span className="block text-sm">
          {agent.label} {t("executable")}
        </span>
        <span className="block truncate text-muted-foreground text-xs">
          {agent.available
            ? `${t("Detected:")} ${agent.executable}`
            : `${t("Not found:")} ${agent.executable}`}
        </span>
      </span>
      <input
        data-testid={`settings-agent-executable-${agent.id}`}
        aria-label={`${agent.label} executable path`}
        value={value}
        placeholder={agent.id === "claude-code" ? "claude" : "codex"}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => onSave(value.trim())}
        className="w-64 rounded border border-border bg-background px-2 py-1.5 text-xs"
      />
    </label>
  )
}

const NOTIFICATION_EVENTS: ReadonlyArray<{
  key: Exclude<keyof NotificationSettings, "muted">
  label: string
  description: string
}> = [
  {
    key: "agentInput",
    label: "Agent needs input",
    description: "When an interactive agent is waiting for a permission, answer, or next turn.",
  },
  {
    key: "agentTurnCompletion",
    label: "Agent finished its turn",
    description: "When a submitted interactive agent turn returns to its normal input prompt.",
  },
  {
    key: "terminalCompletion",
    label: "Terminal command finished",
    description: "When a command submitted in a project terminal returns to its shell prompt.",
  },
  {
    key: "workflowStart",
    label: "Workflow started",
    description: "When a workflow begins running.",
  },
  {
    key: "workflowCompletion",
    label: "Workflow completed",
    description: "When a workflow finishes successfully.",
  },
  {
    key: "workflowFailure",
    label: "Workflow failed",
    description: "When a workflow cannot start or finishes unsuccessfully.",
  },
]

/** Native banner and custom-sound preferences, persisted together in the DB. */
export function NotificationsSection() {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const settingsQuery = useQuery(trpc.settings.get.queryOptions())
  const notifications: NotificationSettings =
    settingsQuery.data?.notifications ?? DEFAULT_NOTIFICATION_SETTINGS
  const [previewMessage, setPreviewMessage] = useState("")
  const update = useMutation(
    trpc.settings.updateNotifications.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() }),
    }),
  )

  const patchEvent = (
    key: Exclude<keyof NotificationSettings, "muted">,
    patch: Partial<NotificationEventSettings>,
  ) => update.mutate({ [key]: patch })

  const preview = async (label: string, sound: NotificationSoundId) => {
    setPreviewMessage(`${t("Playing")} ${t(label)} ${t("preview…")}`)
    const result = await playNotificationSound(sound, { suppressed: false })
    if (result.status === "failed") {
      console.error("Notification sound preview failed", result.error)
      setPreviewMessage(`${t("Could not play")} ${t(label)}: ${result.error.message}`)
      return
    }
    setPreviewMessage(
      result.status === "silent"
        ? `${t(label)} ${t("is set to Silent.")}`
        : `${t("Played")} ${t(label)} ${t("preview.")}`,
    )
  }

  return (
    <SettingsSection
      testId="settings-section-notifications"
      title="Notifications"
      description="Choose which agent and workflow events notify you while PI Lab is unfocused."
    >
      <ToggleField
        testId="settings-notifications-muted"
        label="Mute all notifications"
        description="Suppress native banners and sounds without changing the event choices below."
        checked={notifications.muted}
        onChange={(muted) => update.mutate({ muted })}
      />
      {NOTIFICATION_EVENTS.map((event) => {
        const value = notifications[event.key]
        return (
          <div
            key={event.key}
            data-testid={`settings-notification-${event.key}`}
            className="flex items-center justify-between gap-4 px-4 py-3"
          >
            <div className="flex min-w-0 flex-col">
              <span className="text-foreground text-sm">{t(event.label)}</span>
              <span className="text-muted-foreground text-xs">{t(event.description)}</span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                role="switch"
                aria-checked={value.enabled}
                aria-label={`${t(event.label)} ${t("notifications")}`}
                data-testid={`settings-notification-${event.key}-enabled`}
                onClick={() => patchEvent(event.key, { enabled: !value.enabled })}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                  value.enabled ? "bg-primary" : "bg-muted"
                }`}
              >
                <span
                  className={`inline-block size-4 transform rounded-full bg-background shadow transition-transform ${
                    value.enabled ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </button>
              <select
                aria-label={`${t(event.label)} ${t("sound")}`}
                data-testid={`settings-notification-${event.key}-sound`}
                value={value.sound}
                onChange={(change) =>
                  patchEvent(event.key, { sound: change.target.value as NotificationSoundId })
                }
                className="rounded-md border border-border bg-background px-2 py-1 text-foreground text-sm outline-none"
              >
                {NOTIFICATION_SOUND_OPTIONS.map((sound) => (
                  <option key={sound.id} value={sound.id}>
                    {t(sound.label)}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`${t("Preview")} ${t(event.label)} ${t("sound")}`}
                data-testid={`settings-notification-${event.key}-preview`}
                onClick={() => void preview(event.label, value.sound)}
              >
                {t("Preview")}
              </Button>
            </div>
          </div>
        )
      })}
      <p
        data-testid="notification-preview-status"
        aria-live="polite"
        className="min-h-8 px-4 py-2 text-muted-foreground text-xs"
      >
        {previewMessage}
      </p>
    </SettingsSection>
  )
}

/** Persisted sleep-prevention mode and blocker scope, applied immediately by main. */
export function CaffeineSection() {
  const t = useTranslate()
  const { status, setMode, setScope } = useCaffeine()

  return (
    <SettingsSection
      testId="settings-section-caffeine"
      title="Caffeine"
      description="Prevent the computer from sleeping."
    >
      <SelectField
        testId="settings-caffeine-mode"
        label="Mode"
        description="Off never blocks sleep, On always blocks it, and Auto follows tracked work."
        value={status.mode}
        options={[
          { value: "off", label: "Off" },
          { value: "on", label: "On" },
          { value: "auto", label: "Auto" },
        ]}
        onChange={(mode) => setMode(mode as CaffeineMode)}
      />
      <SelectField
        testId="settings-caffeine-scope"
        label="Blocker scope"
        description="Keep the system running, or keep both the system and display awake."
        value={status.scope}
        options={[
          { value: "system-only", label: "System only" },
          { value: "system-plus-display", label: "System and display" },
        ]}
        onChange={(scope) => setScope(scope as CaffeineScope)}
      />
      <p
        data-testid="settings-caffeine-status"
        data-held={status.held}
        aria-live="polite"
        className="px-4 py-3 text-muted-foreground text-xs"
      >
        {t("Power blocker")} {status.held ? t("active") : t("idle")}.
      </p>
    </SettingsSection>
  )
}

/** Library — choose the source (Zotero local/cloud, or a folder of PDFs) + connect. */
export function LibrarySection() {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const status = useQuery(trpc.science.library.getStatus.queryOptions())
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.science.library.getStatus.queryKey() })
    void queryClient.invalidateQueries({
      queryKey: trpc.science.library.listCollections.queryKey(),
    })
    void queryClient.invalidateQueries({ queryKey: trpc.science.library.listItems.queryKey() })
  }
  const connect = useMutation(
    trpc.science.library.connect.mutationOptions({ onSuccess: () => invalidate() }),
  )
  const disconnect = useMutation(
    trpc.science.library.disconnect.mutationOptions({ onSuccess: () => invalidate() }),
  )

  const data = status.data
  const connected = data?.connected ?? false
  const sourceLabel =
    data?.kind === "folder"
      ? t("Local folder")
      : data?.mode === "local"
        ? t("Zotero — Local desktop API")
        : t("Zotero — Cloud Web API")
  const detail =
    data?.kind === "folder"
      ? `${data.folderPath} · ${t("read-only")}`
      : `${data?.libraryType === "group" ? t("Group") : t("User")} ${t("library")} ${data?.libraryId} · ${
          data?.canWrite ? t("file attachment enabled") : t("read-only")
        }`

  return (
    <SettingsSection
      testId="settings-section-library"
      title="Library"
      description="Browse a library in the Library tab — Zotero (local or cloud), or a folder of PDFs."
    >
      {connected ? (
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col">
              <span className="text-foreground text-sm">
                {t("Connected")} — {sourceLabel}
              </span>
              <span className="cursor-text select-text truncate text-muted-foreground text-xs">
                {detail}
              </span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="settings-library-disconnect"
              data-feature-label={t("Disconnect library")}
              data-feature-help={t(
                "Disconnect this library source so you can select a different Zotero library or PDF folder.",
              )}
              className="shrink-0 text-muted-foreground"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              {t("Disconnect")}
            </Button>
          </div>
          <p className="text-muted-foreground/70 text-xs">
            {t("To switch source, disconnect and choose again.")}
          </p>
        </div>
      ) : (
        <div className="px-4 py-4">
          <LibrarySourceChooser
            onConnect={(values) => connect.mutate(values)}
            isPending={connect.isPending}
            error={connect.error?.message ?? null}
          />
        </div>
      )}
    </SettingsSection>
  )
}

/** Project view — layout toggles for the project workspace. */
export function ProjectViewSection() {
  const t = useTranslate()
  const trpc = useTRPC()
  const projectsQuery = useQuery(trpc.projects.list.queryOptions())
  const projects = projectsQuery.data ?? []
  const [selectedProjectId, setSelectedProjectId] = useState("")
  const [planningProjectId, setPlanningProjectId] = useState<string | null>(null)
  const planningProject = useQuery({
    ...trpc.projects.get.queryOptions({ id: planningProjectId ?? "" }),
    enabled: planningProjectId !== null,
  })
  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? projects[0]
  const [showCodeChanges, setShowCodeChanges] = useShowCodeChanges()
  const [showSkillsPanel, setShowSkillsPanel] = useShowSkillsPanel()
  return (
    <SettingsSection
      testId="settings-section-project-view"
      title="Project view"
      description="What shows in the project workspace."
    >
      <ToggleField
        testId="settings-show-code-changes"
        label='Show "Code changes" panel'
        description="Reveal the git working-tree diff in the right sidebar (off by default)."
        checked={showCodeChanges}
        onChange={setShowCodeChanges}
      />
      <ToggleField
        testId="settings-show-skills"
        label='Show "Skills" panel'
        description="Reveal project-local and global skills in the right sidebar (off by default)."
        checked={showSkillsPanel}
        onChange={setShowSkillsPanel}
      />
      <div className="flex flex-col gap-3 px-4 py-3">
        <label htmlFor="settings-main-project" className="text-sm">
          {t("Project files")}
        </label>
        <select
          id="settings-main-project"
          data-testid="settings-main-project"
          aria-label={t("Project")}
          value={selectedProject?.id ?? ""}
          onChange={(event) => setSelectedProjectId(event.target.value)}
          className="rounded border border-border bg-background px-2 py-1 text-sm"
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        {selectedProject ? (
          <>
            <p className="text-xs">{t("Project type")}</p>
            <ProjectTypeChoice
              projectId={selectedProject.id}
              typeId={selectedProject.typeId}
              testId="settings-project-type"
            />
            <ProjectMarkdownChoice
              key={selectedProject.id}
              projectId={selectedProject.id}
              kind="main"
              currentPath={selectedProject.mainRelPath}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => setPlanningProjectId(selectedProject.id)}
            >
              {t("Plan this project")}
            </Button>
            {planningProjectId === selectedProject.id && planningProject.data ? (
              <ProjectSetupWizard
                project={planningProject.data}
                optional={false}
                onDone={() => setPlanningProjectId(null)}
              />
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground text-xs">
            {t("Add a project to choose its main readme.")}
          </p>
        )}
      </div>
    </SettingsSection>
  )
}

/**
 * Sections — enable or hide the optional app sections. Cluster and Analysis are
 * live surfaces: their toggle gates the sidebar nav row and guards the route.
 * Experiments and Research Heartbeat have no surface yet, so their rows are shown
 * as not-yet-available (a disabled toggle with a "when available" hint) rather
 * than pretending to hide something that doesn't exist.
 */
export function SectionsSection() {
  const [showCluster, setShowCluster] = useShowClusterSection()
  const [showAnalysis, setShowAnalysis] = useShowAnalysisSection()
  const [showExperiments] = useShowExperimentsSection()
  const [showResearchHeartbeat] = useShowResearchHeartbeatSection()
  return (
    <SettingsSection
      testId="settings-section-sections"
      title="Sections"
      description="Show or hide the optional app sections in the sidebar."
    >
      <ToggleField
        testId="settings-show-cluster-section"
        label="Cluster"
        description="Show the Cluster section for monitoring compute machines."
        checked={showCluster}
        onChange={setShowCluster}
      />
      <ToggleField
        testId="settings-show-analysis-section"
        label="Analysis"
        description="Show the Analysis section for browsing and previewing data files."
        checked={showAnalysis}
        onChange={setShowAnalysis}
      />
      <ToggleField
        testId="settings-show-experiments-section"
        label="Experiments"
        description="Available in a future release — this section isn't built yet."
        checked={showExperiments}
        onChange={() => undefined}
        disabled
      />
      <ToggleField
        testId="settings-show-research-heartbeat-section"
        label="Research Heartbeat"
        description="Available in a future release — this section isn't built yet."
        checked={showResearchHeartbeat}
        onChange={() => undefined}
        disabled
      />
    </SettingsSection>
  )
}

/**
 * Remote experiments — configure the "Fetch remote experiments" button. Only the
 * extra instructions text is user-editable; the scaffolded skill name/path stays
 * fixed server-side. The instructions are appended to the agent's prompt at launch.
 * (Named "Remote experiments" to disambiguate from the disabled "Experiments"
 * section row in the Sections settings.)
 */
export function ExperimentsSection() {
  const [instructions, setInstructions] = useFetchExperimentsInstructions()
  return (
    <SettingsSection
      testId="settings-section-experiments"
      title="Remote experiments"
      description="Configure the “Fetch remote experiments” button."
    >
      <TextAreaField
        testId="settings-fetch-experiments-instructions"
        label="Fetch instructions"
        description="Extra instructions appended to the agent prompt when fetching remote experiments. The fetch-experiments skill is scaffolded on first use and editable in the project."
        value={instructions}
        placeholder="e.g. Only pull the latest run's metrics into results/."
        onChange={setInstructions}
      />
    </SettingsSection>
  )
}

/** Experimental — gate v2 surfaces (integrations / teams) as they ship. */
export function ExperimentalSection() {
  const [experimentalV2, setExperimentalV2] = useExperimentalV2()
  return (
    <SettingsSection
      testId="settings-section-experimental"
      title="Experimental"
      description="Preview features that aren't final — they may change or break."
    >
      <ToggleField
        testId="settings-experimental-v2"
        label="Experimental v2 features"
        description="Enable upcoming v2 surfaces (integrations, teams) as they become available."
        checked={experimentalV2}
        onChange={setExperimentalV2}
      />
    </SettingsSection>
  )
}

/** Shortcuts — rebind the app-global shortcuts; editor keys shown for reference. */
export function ShortcutsSection() {
  const t = useTranslate()
  const { bindingFor, setBinding, resetBinding } = useShortcutBindings()
  const [recording, setRecording] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{
    binding: string
    existingLabel: string
    targetLabel: string
  } | null>(null)

  useLayoutEffect(() => {
    if (!recording) return
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const binding = bindingFromEvent(event)
      if (binding) {
        const existing = findShortcutConflict(recording, binding, bindingFor)
        if (existing) {
          const target = SHORTCUTS.find((shortcut) => shortcut.id === recording)
          setConflict({
            binding,
            existingLabel: existing.label,
            targetLabel: target?.label ?? "this action",
          })
          return
        }
        setConflict(null)
        setBinding(recording, binding)
        setRecording(null)
      }
    }
    window.addEventListener("keydown", onKeyDown, { capture: true })
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true })
  }, [bindingFor, recording, setBinding])

  const toggleRecording = (shortcutId: string): void => {
    setConflict(null)
    setRecording((current) => (current === shortcutId ? null : shortcutId))
  }

  const resetShortcut = (shortcutId: string): void => {
    const target = SHORTCUTS.find((shortcut) => shortcut.id === shortcutId)
    if (!target) return
    const existing = findShortcutConflict(shortcutId, target.defaultBinding, bindingFor)
    if (existing) {
      setConflict({
        binding: target.defaultBinding,
        existingLabel: existing.label,
        targetLabel: target.label,
      })
      setRecording(shortcutId)
      return
    }
    setConflict(null)
    if (recording === shortcutId) setRecording(null)
    resetBinding(shortcutId)
  }

  return (
    <SettingsSection
      testId="settings-section-shortcuts"
      title="Shortcuts"
      description="App-global shortcuts can be rebound; editor keys are shown for reference."
    >
      {conflict ? (
        <p
          role="alert"
          data-testid="shortcut-conflict"
          className="cursor-text select-text bg-destructive/10 px-4 py-3 text-destructive text-xs"
        >
          {formatBinding(conflict.binding)} {t("cannot be used for")} {t(conflict.targetLabel)}{" "}
          {t("because it is already assigned to")} {t(conflict.existingLabel)}.{" "}
          {t("Choose another shortcut or cancel.")}
        </p>
      ) : null}
      {SHORTCUTS.map((shortcut) => (
        <div key={shortcut.id} className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="flex min-w-0 flex-col">
            <span className="text-foreground text-sm">{t(shortcut.label)}</span>
            <span className="text-muted-foreground text-xs">{t(shortcut.description)}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <kbd
              data-testid={`shortcut-${shortcut.id}`}
              className="min-w-12 rounded-md border border-border bg-muted px-2 py-1 text-center font-mono text-foreground text-xs"
            >
              {recording === shortcut.id
                ? t("Press keys…")
                : formatBinding(bindingFor(shortcut.id))}
            </kbd>
            {shortcut.editable ? (
              <>
                <button
                  type="button"
                  data-testid={`shortcut-${shortcut.id}-rebind`}
                  data-feature-help={t("Record a new key combination for this app shortcut")}
                  onClick={() => toggleRecording(shortcut.id)}
                  className="rounded-md border border-border px-2 py-1 text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
                >
                  {recording === shortcut.id ? t("Cancel") : t("Rebind")}
                </button>
                <button
                  type="button"
                  data-testid={`shortcut-${shortcut.id}-reset`}
                  data-feature-help={t("Restore this shortcut's default key combination")}
                  onClick={() => resetShortcut(shortcut.id)}
                  className="rounded-md px-2 py-1 text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
                >
                  {t("Reset")}
                </button>
              </>
            ) : (
              <span className="text-muted-foreground/70 text-xs">{t("reference")}</span>
            )}
          </div>
        </div>
      ))}
    </SettingsSection>
  )
}
