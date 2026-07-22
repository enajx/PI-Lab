import { Button, cn } from "@pi-lab/ui"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { ArrowLeft } from "lucide-react"
import { useState } from "react"
import { CaffeineControl } from "../../caffeine"
import { useSidebarFeatureHelp } from "../../preferences/preferences"
import { readSettingsReturnRoute } from "./-settingsReturnRoute"
import { FeatureHelpPanel, FeatureHelpRestoreButton, useFeatureHelp } from "./components/Sidebar"
import { ProjectTemplateSection } from "./settings/components/ProjectTemplateSection"
import {
  AgentsSection,
  AppearanceSection,
  CaffeineSection,
  EditorSection,
  ExperimentalSection,
  ExperimentsSection,
  GeneralSection,
  LibrarySection,
  NotificationsSection,
  ProjectViewSection,
  SectionsSection,
  ShortcutsSection,
} from "./settings/components/SettingsSections"

/**
 * Settings (plan "Settings panel, project-view rework"). A local-only preferences
 * surface reachable from the sidebar gear and ⌘, — a left section nav plus a
 * scrollable content column (bounded flex + native scroll, AGENTS.md Pitfalls #3).
 * Back-end-affecting settings (editor, worktree/quit policy) round-trip through
 * the `settings` router; pure-UI prefs (theme, code-changes panel, experimental,
 * shortcuts) live in localStorage (see `preferences`/`shortcuts`).
 *
 * Settings is full-screen (the shell hides the sidebar on this route). It mirrors the
 * main view's surfaces: the left section nav uses `bg-sidebar` (the same grey as the
 * app's left sidebar) while the content column stays `bg-background` (white in light),
 * rather than tinting the whole panel. The header carries the only way back: a Back
 * control to the view that opened Settings. The header is an app-drag strip with left padding so the macOS
 * traffic lights don't overlap the title or Back button.
 */
export const Route = createFileRoute("/_shell/settings")({
  component: SettingsView,
})

const SECTIONS = [
  {
    id: "general",
    label: "General",
    description: "Configure app-wide behavior such as quit confirmation.",
    render: () => <GeneralSection />,
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Choose PI Lab's color theme and visual appearance.",
    render: () => <AppearanceSection />,
  },
  {
    id: "editor",
    label: "Editor",
    description: "Configure saving, keybindings, diagnostics, formatting, and editor themes.",
    render: () => <EditorSection />,
  },
  {
    id: "agents",
    label: "Agents & worktrees",
    description: "Choose defaults for launching agents and isolating their Git work.",
    render: () => <AgentsSection />,
  },
  {
    id: "notifications",
    label: "Notifications",
    description: "Choose native banners and sounds for agent and workflow events.",
    render: () => <NotificationsSection />,
  },
  {
    id: "caffeine",
    label: "Caffeine",
    description: "Prevent the computer from sleeping.",
    render: () => <CaffeineSection />,
  },
  {
    id: "project-template",
    label: "Project template",
    description: "Edit the starter files copied into newly created projects.",
    render: () => <ProjectTemplateSection />,
  },
  {
    id: "library",
    label: "Library",
    description: "Connect Zotero or a local PDF folder as the research library.",
    render: () => <LibrarySection />,
  },
  {
    id: "project-view",
    label: "Project view",
    description: "Choose which file and Git panels appear in project workspaces.",
    render: () => <ProjectViewSection />,
  },
  {
    id: "sections",
    label: "Sections",
    description: "Enable or hide optional app sections in the sidebar.",
    render: () => <SectionsSection />,
  },
  {
    id: "experiments",
    label: "Remote experiments",
    description: "Configure the “Fetch remote experiments” button.",
    render: () => <ExperimentsSection />,
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    description: "Review and rebind app-wide keyboard shortcuts.",
    render: () => <ShortcutsSection />,
  },
  {
    id: "experimental",
    label: "Experimental",
    description: "Enable unfinished preview features that may change or break.",
    render: () => <ExperimentalSection />,
  },
] as const

export function SettingsView() {
  const navigate = useNavigate()
  const [activeId, setActiveId] = useState<string>(SECTIONS[0].id)
  const [showFeatureHelp, setShowFeatureHelp] = useSidebarFeatureHelp()
  const featureHelp = useFeatureHelp(showFeatureHelp)
  const active = SECTIONS.find((section) => section.id === activeId) ?? SECTIONS[0]
  const onBack = () => {
    const previous = readSettingsReturnRoute()
    void navigate({ to: previous.pathname as never, search: previous.search as never })
  }

  return (
    <div data-testid="settings-view" className="flex h-full w-full flex-col overflow-hidden">
      <header className="app-drag flex h-14 shrink-0 items-center gap-3 border-border border-b pr-6 pl-20">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="settings-back"
          aria-label="Back"
          title="Back"
          data-feature-help="Return to the view that opened Settings"
          className="app-no-drag size-7 text-foreground"
          onClick={onBack}
        >
          <ArrowLeft aria-hidden />
        </Button>
        <h1 className="font-semibold text-foreground text-sm tracking-tight">Settings</h1>
        <CaffeineControl className="ml-auto" />
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Settings sections"
          className="flex w-48 shrink-0 flex-col gap-0.5 border-border border-r bg-sidebar p-2"
        >
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              data-testid={`settings-nav-${section.id}`}
              data-active={section.id === active.id}
              data-feature-label={section.label}
              data-feature-help={section.description}
              onClick={() => setActiveId(section.id)}
              className={cn(
                "rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                section.id === active.id
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {section.label}
            </button>
          ))}
          <div className="mt-auto border-sidebar-border border-t pt-3">
            {showFeatureHelp ? (
              <FeatureHelpPanel help={featureHelp} onHide={() => setShowFeatureHelp(false)} />
            ) : (
              <FeatureHelpRestoreButton
                collapsed={false}
                onRestore={() => setShowFeatureHelp(true)}
              />
            )}
          </div>
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">{active.render()}</div>
      </div>
    </div>
  )
}
