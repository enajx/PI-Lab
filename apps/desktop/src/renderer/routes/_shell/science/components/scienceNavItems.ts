import type { LinkProps } from "@tanstack/react-router"
import { ChartArea, FlaskConical, Library, ListTodo, Server } from "lucide-react"
import type { ComponentType } from "react"

/**
 * Declarative registry of the v1 science tabs. This is the
 * single seam for adding a science tab: append an entry here and add its route
 * under `routes/_shell/science/<id>.tsx` — the sidebar maps over this list, so
 * there is no per-tab nav fork.
 *
 * v1 ships, in order, **Tasks**, **Library**, **Analysis**, **Cluster**, and
 * **Skills**. Each entry points at its route under
 * `routes/_shell/science/<id>.tsx`.
 */
export interface ScienceNavItem {
  /** Stable id (also the React key and the `data-science-tab` attribute). */
  id: string
  label: string
  /** Concise purpose shown by the app-wide feature-help panel. */
  description: string
  icon: ComponentType<{ className?: string }>
  /** Whether the tab is built and routable yet. */
  ready: boolean
  /** TanStack Router target (only meaningful when `ready`). */
  to?: LinkProps["to"]
}

export const scienceNavItems: ScienceNavItem[] = [
  {
    id: "tasks",
    label: "Tasks",
    description: "Manage every project's TODO Markdown from one list or Kanban.",
    icon: ListTodo,
    ready: true,
    to: "/science/tasks",
  },
  {
    id: "library",
    label: "Library",
    description: "Browse research papers from Zotero or a folder of PDFs.",
    icon: Library,
    ready: true,
    to: "/science/library",
  },
  {
    id: "analysis",
    label: "Analysis",
    description: "Browse and preview data files across your projects.",
    icon: ChartArea,
    ready: true,
    to: "/science/analysis",
  },
  {
    id: "cluster",
    label: "Cluster",
    description:
      "Monitor compute machines from your SSH config, including reachability and hardware usage.",
    icon: Server,
    ready: true,
    to: "/science/cluster",
  },
  {
    id: "skills",
    label: "Skills",
    description: "Browse the agent skills declared in your project repositories.",
    icon: FlaskConical,
    ready: true,
    to: "/science/skills",
  },
]
