import { Button, cn } from "@skipper/ui"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { ArrowLeft } from "lucide-react"
import { useState } from "react"
import { ProjectTemplateSection } from "./settings/components/ProjectTemplateSection"
import {
  AgentsSection,
  AppearanceSection,
  EditorSection,
  ExperimentalSection,
  GeneralSection,
  LibrarySection,
  ProjectViewSection,
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
 * control to "/". The header is an app-drag strip with left padding so the macOS
 * traffic lights don't overlap the title or Back button.
 */
export const Route = createFileRoute("/_shell/settings")({
  component: SettingsView,
})

const SECTIONS = [
  { id: "general", label: "General", render: () => <GeneralSection /> },
  { id: "appearance", label: "Appearance", render: () => <AppearanceSection /> },
  { id: "editor", label: "Editor", render: () => <EditorSection /> },
  { id: "agents", label: "Agents & worktrees", render: () => <AgentsSection /> },
  { id: "project-template", label: "Project template", render: () => <ProjectTemplateSection /> },
  { id: "library", label: "Library", render: () => <LibrarySection /> },
  { id: "project-view", label: "Project view", render: () => <ProjectViewSection /> },
  { id: "shortcuts", label: "Shortcuts", render: () => <ShortcutsSection /> },
  { id: "experimental", label: "Experimental", render: () => <ExperimentalSection /> },
] as const

function SettingsView() {
  const navigate = useNavigate()
  const [activeId, setActiveId] = useState<string>(SECTIONS[0].id)
  const active = SECTIONS.find((section) => section.id === activeId) ?? SECTIONS[0]

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
          className="app-no-drag size-7 text-foreground"
          onClick={() => void navigate({ to: "/" })}
        >
          <ArrowLeft aria-hidden />
        </Button>
        <h1 className="font-semibold text-foreground text-sm tracking-tight">Settings</h1>
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
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">{active.render()}</div>
      </div>
    </div>
  )
}
