import type { EditorSettings } from "@skipper/local-db"
import { Button } from "@skipper/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { DEFAULT_EDITOR_THEME_ID, EDITOR_THEMES } from "../../../../Editor/components/editorThemes"
import { DEFAULT_EDITOR_SETTINGS } from "../../../../Editor/hooks/useEditorBuffers"
import {
  useDefaultAgentId,
  useExperimentalV2,
  useShowCodeChanges,
} from "../../../../preferences/preferences"
import { type ThemeMode, useTheme } from "../../../../providers/ThemeProvider"
import {
  bindingFromEvent,
  formatBinding,
  SHORTCUTS,
  useShortcutBindings,
} from "../../../../shortcuts/shortcuts"
import { useTRPC } from "../../../../trpc/react"
import { LibrarySourceChooser } from "../../science/components/ScienceLibrary/components/LibrarySourceChooser"
import { SelectField, SettingsSection, ToggleField } from "./SettingsControls"

/** General — app-wide behavior (DB-backed via `settings.updateGeneral`). The default
 *  Settings landing (⌘,). */
export function GeneralSection() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const settingsQuery = useQuery(trpc.settings.get.queryOptions())
  const updateGeneral = useMutation(
    trpc.settings.updateGeneral.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() }),
    }),
  )
  const confirmOnQuit = settingsQuery.data?.confirmOnQuit ?? true

  return (
    <SettingsSection
      testId="settings-section-general"
      title="General"
      description="App-wide behavior."
    >
      <ToggleField
        testId="settings-confirm-quit"
        label="Confirm on quit"
        description="Ask before quitting while agents are running."
        checked={confirmOnQuit}
        onChange={(value) => updateGeneral.mutate({ confirmOnQuit: value })}
      />
    </SettingsSection>
  )
}

/** Appearance — theme (the first real UI for the existing ThemeProvider). */
export function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  return (
    <SettingsSection
      testId="settings-section-appearance"
      title="Appearance"
      description="How Skipper looks."
    >
      <SelectField
        testId="settings-theme"
        label="Theme"
        description="Dark or light interface."
        value={theme}
        options={[
          { value: "dark", label: "Dark" },
          { value: "light", label: "Light" },
        ]}
        onChange={(value) => setTheme(value as ThemeMode)}
      />
    </SettingsSection>
  )
}

/** Editor — the same four preferences as the in-editor gear, persisted in the DB. */
export function EditorSection() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const settingsQuery = useQuery(trpc.settings.get.queryOptions())
  const editor: EditorSettings = settingsQuery.data?.editor ?? DEFAULT_EDITOR_SETTINGS
  const update = useMutation(
    trpc.settings.updateEditor.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() }),
    }),
  )
  const patch = (next: Partial<EditorSettings>) => update.mutate(next)

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
        testId="settings-editor-theme"
        label="Editor theme"
        description="Color theme for the code editor."
        value={
          EDITOR_THEMES.some((theme) => theme.id === editor.editorTheme)
            ? (editor.editorTheme ?? DEFAULT_EDITOR_THEME_ID)
            : DEFAULT_EDITOR_THEME_ID
        }
        groups={[
          {
            label: "Light",
            options: EDITOR_THEMES.filter((theme) => theme.mode === "light").map((theme) => ({
              value: theme.id,
              label: theme.label,
            })),
          },
          {
            label: "Dark",
            options: EDITOR_THEMES.filter((theme) => theme.mode === "dark").map((theme) => ({
              value: theme.id,
              label: theme.label,
            })),
          },
        ]}
        onChange={(value) => patch({ editorTheme: value })}
      />
    </SettingsSection>
  )
}

/** Agents & worktrees — default agent + the session/quit policies (DB-backed). */
export function AgentsSection() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const agentsQuery = useQuery(trpc.agents.list.queryOptions())
  const settingsQuery = useQuery(trpc.settings.get.queryOptions())
  const [defaultAgent, setDefaultAgent] = useDefaultAgentId()
  const updateGeneral = useMutation(
    trpc.settings.updateGeneral.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() }),
    }),
  )

  const agents = agentsQuery.data ?? []
  const worktreePerAgent = settingsQuery.data?.worktreePerAgent ?? false

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
    </SettingsSection>
  )
}

/** Library — choose the source (Zotero local/cloud, or a folder of PDFs) + connect. */
export function LibrarySection() {
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
      ? "Local folder"
      : data?.mode === "local"
        ? "Zotero — Local desktop API"
        : "Zotero — Cloud Web API"
  const detail =
    data?.kind === "folder"
      ? `${data.folderPath} · read-only`
      : `${data?.libraryType === "group" ? "Group" : "User"} library ${data?.libraryId} · ${
          data?.canWrite ? "file attachment enabled" : "read-only"
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
              <span className="text-foreground text-sm">Connected — {sourceLabel}</span>
              <span className="cursor-text select-text truncate text-muted-foreground text-xs">
                {detail}
              </span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="settings-library-disconnect"
              className="shrink-0 text-muted-foreground"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              Disconnect
            </Button>
          </div>
          <p className="text-muted-foreground/70 text-xs">
            To switch source, disconnect and choose again.
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
  const [showCodeChanges, setShowCodeChanges] = useShowCodeChanges()
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
  const { bindingFor, setBinding, resetBinding } = useShortcutBindings()
  const [recording, setRecording] = useState<string | null>(null)

  useEffect(() => {
    if (!recording) return
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      const binding = bindingFromEvent(event)
      if (binding) {
        setBinding(recording, binding)
        setRecording(null)
      }
    }
    window.addEventListener("keydown", onKeyDown, { capture: true })
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true })
  }, [recording, setBinding])

  return (
    <SettingsSection
      testId="settings-section-shortcuts"
      title="Shortcuts"
      description="App-global shortcuts can be rebound; editor keys are shown for reference."
    >
      {SHORTCUTS.map((shortcut) => (
        <div key={shortcut.id} className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="flex min-w-0 flex-col">
            <span className="text-foreground text-sm">{shortcut.label}</span>
            <span className="text-muted-foreground text-xs">{shortcut.description}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <kbd
              data-testid={`shortcut-${shortcut.id}`}
              className="min-w-12 rounded-md border border-border bg-muted px-2 py-1 text-center font-mono text-foreground text-xs"
            >
              {recording === shortcut.id ? "Press keys…" : formatBinding(bindingFor(shortcut.id))}
            </kbd>
            {shortcut.editable ? (
              <>
                <button
                  type="button"
                  data-testid={`shortcut-${shortcut.id}-rebind`}
                  onClick={() => setRecording((cur) => (cur === shortcut.id ? null : shortcut.id))}
                  className="rounded-md border border-border px-2 py-1 text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
                >
                  {recording === shortcut.id ? "Cancel" : "Rebind"}
                </button>
                <button
                  type="button"
                  data-testid={`shortcut-${shortcut.id}-reset`}
                  onClick={() => resetBinding(shortcut.id)}
                  className="rounded-md px-2 py-1 text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
                >
                  Reset
                </button>
              </>
            ) : (
              <span className="text-muted-foreground/70 text-xs">reference</span>
            )}
          </div>
        </div>
      ))}
    </SettingsSection>
  )
}
