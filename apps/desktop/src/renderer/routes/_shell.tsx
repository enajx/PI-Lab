import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router"
import { FolderGit2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { CommandPalette } from "../CommandPalette"
import { useSidebarCollapsed } from "../preferences/preferences"
import { QuickFind, type QuickFindItem } from "../QuickFind"
import { eventMatchesShortcut } from "../shortcuts/shortcuts"
import { useTRPC } from "../trpc/react"
import { Sidebar } from "./_shell/components/Sidebar"
import { useTitleBarTrafficLights } from "./_shell/titleBar"

/**
 * Pathless layout route — the default app surface (docs/architecture.md (renderer)): a ROW of
 * [sidebar | main]. The gray sidebar owns the window's top-left — its own header clears the
 * macOS traffic lights and holds the collapse toggle — and each page renders its header as the
 * top row of the main column (single header level, not a full-width bar). The content column is
 * a bounded flex child owning its own vertical scroll (AGENTS.md Pitfalls #3). `<Outlet />`.
 *
 * Two global palettes are mounted here:
 *  - **⌘P command palette** (commands + projects) — opens from any surface.
 *  - **⌘F quick-find** is context-aware: inside a project it finds files; each science tab finds
 *    its own content (Library collections, Skills, Cluster machines, Analysis files); everywhere
 *    else (dashboard, Workflows) this shell finds a project to jump to.
 *
 * Settings is full-screen: on `/settings` the sidebar is hidden so the panel fills the window.
 */
export const Route = createFileRoute("/_shell")({
  component: ShellLayout,
})

function ShellLayout() {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [findProjectsOpen, setFindProjectsOpen] = useState(false)
  useGlobalShortcuts(() => setPaletteOpen(true))
  const { location } = useRouterState()
  const isSettings = location.pathname.startsWith("/settings")

  // Keep the macOS traffic lights in sync with the layout: they ride the title-bar
  // strip above the main panel only when the sidebar is shown AND collapsed, and sit
  // on the sidebar header otherwise (expanded, or Settings — which hides the sidebar).
  const [collapsed] = useSidebarCollapsed()
  useTitleBarTrafficLights({ sidebarShown: !isSettings, collapsed })

  // ⌘F (the `quick-open` shortcut) is context-aware. The project view (files) and every science
  // tab (Library collections, Skills, Cluster machines, Analysis files) own ⌘F for their own
  // content, so the shell only handles it on the remaining surfaces (dashboard, Workflows, …) —
  // where it finds a project to jump to. Reading the path from a ref keeps the listener stable.
  const pathRef = useRef(location.pathname)
  pathRef.current = location.pathname
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!eventMatchesShortcut(event, "quick-open")) return
      const path = pathRef.current
      if (path.startsWith("/projects/") || path.startsWith("/science/")) return
      event.preventDefault()
      setFindProjectsOpen(true)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const content = (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </main>
  )

  return (
    <>
      {isSettings ? (
        <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
          {content}
        </div>
      ) : (
        <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
          <Sidebar />
          {content}
        </div>
      )}
      {paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} /> : null}
      {findProjectsOpen ? <ProjectsFind onClose={() => setFindProjectsOpen(false)} /> : null}
    </>
  )
}

/** ⌘F outside a project/Library: fuzzy-find an opened project and jump to it. */
function ProjectsFind({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const trpc = useTRPC()
  const projects = useQuery(trpc.projects.list.queryOptions()).data ?? []
  const items: QuickFindItem[] = projects.map((project) => ({
    id: project.id,
    label: project.name,
    hint: project.repoPath,
    icon: FolderGit2,
  }))
  return (
    <QuickFind
      ariaLabel="Find a project"
      placeholder="Find a project…"
      items={items}
      emptyText={projects.length === 0 ? "No projects yet" : "No matching projects"}
      onSelect={(item) =>
        void navigate({ to: "/projects/$projectId", params: { projectId: item.id } })
      }
      onClose={onClose}
    />
  )
}

/**
 * App-global keyboard shortcuts. ⌘, (rebindable) opens Settings; ⌘P (rebindable) opens the
 * command palette. Handlers read the *current* binding at event time, so a rebind in Settings
 * takes effect with no listener re-subscription.
 */
function useGlobalShortcuts(onCommandPalette: () => void): void {
  const navigate = useNavigate()
  const paletteRef = useRef(onCommandPalette)
  paletteRef.current = onCommandPalette
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (eventMatchesShortcut(event, "open-settings")) {
        event.preventDefault()
        void navigate({ to: "/settings" })
      } else if (eventMatchesShortcut(event, "command-palette")) {
        event.preventDefault()
        paletteRef.current()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [navigate])
}
