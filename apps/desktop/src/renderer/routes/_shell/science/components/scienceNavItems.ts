import type { LinkProps } from "@tanstack/react-router"
import { ChartArea, FlaskConical, Library, Server } from "lucide-react"
import type { ComponentType } from "react"

/**
 * Declarative registry of the v1 science tabs (AGENTS.md §1 / §7). This is the
 * single seam for adding a science tab: append an entry here and add its route
 * under `routes/_shell/science/<id>.tsx` — the sidebar maps over this list, so
 * there is no per-tab nav fork.
 *
 * v1 ships four tabs — **Cluster**, **Analysis**, **Skills**, and **Library** —
 * all wired. A `ready: false` entry (none remain) would render disabled /
 * "coming soon"; adding a future tab is appending an entry here plus its route
 * under `routes/_shell/science/<id>.tsx`.
 */
export interface ScienceNavItem {
  /** Stable id (also the React key and the `data-science-tab` attribute). */
  id: string
  label: string
  icon: ComponentType<{ className?: string }>
  /** Whether the tab is built and routable yet. */
  ready: boolean
  /** TanStack Router target (only meaningful when `ready`). */
  to?: LinkProps["to"]
}

export const scienceNavItems: ScienceNavItem[] = [
  {
    id: "cluster",
    label: "Cluster",
    icon: Server,
    ready: true,
    to: "/science/cluster",
  },
  {
    id: "analysis",
    label: "Analysis",
    icon: ChartArea,
    ready: true,
    to: "/science/analysis",
  },
  {
    id: "skills",
    label: "Skills",
    icon: FlaskConical,
    ready: true,
    to: "/science/skills",
  },
  {
    id: "library",
    label: "Library",
    icon: Library,
    ready: true,
    to: "/science/library",
  },
]
