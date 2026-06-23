import { useQuery } from "@tanstack/react-query"
import { useTRPC } from "../../../../../trpc/react"
import { MAX_CARD_SIZE, MIN_CARD_SIZE, useCardSize } from "../../hooks/useCardSize"
import { ProjectCard } from "../ProjectCard"

/**
 * The project-cards dashboard — the shell home (md/02 — "Dashboard & project
 * cards", AGENTS.md §7/§11 P7). A responsive grid of large project cards, one per
 * opened project (most-recently-opened first, mirroring the sidebar), with a
 * toolbar size slider that scales the cards and persists to localStorage.
 *
 * This is the functional first pass: the structure (grid, card, gradient/
 * thumbnail/drag-drop, slider) is here; the heavy visual polish and the richer
 * per-card contents are intentionally deferred.
 */
export function Dashboard() {
  const trpc = useTRPC()
  const projectsQuery = useQuery(trpc.projects.list.queryOptions())
  const { size, setSize } = useCardSize()

  const projects = projectsQuery.data ?? []

  return (
    <div data-testid="dashboard" className="flex h-full flex-col">
      <header className="flex shrink-0 items-center justify-between gap-4 border-border border-b px-6 py-3">
        <h1 className="font-semibold text-foreground text-sm tracking-tight">Dashboard</h1>
        <label className="flex items-center gap-2 text-muted-foreground text-xs">
          Card size
          <input
            data-testid="card-size-slider"
            type="range"
            min={MIN_CARD_SIZE}
            max={MAX_CARD_SIZE}
            value={size}
            onChange={(event) => setSize(Number(event.target.value))}
            className="w-32 accent-brand"
            aria-label="Card size"
          />
        </label>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {projects.length === 0 ? (
          <p
            data-testid="dashboard-empty"
            className="text-muted-foreground text-sm leading-relaxed"
          >
            No projects yet.
          </p>
        ) : (
          <div
            data-testid="dashboard-grid"
            className="grid gap-4"
            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size}px, 1fr))` }}
          >
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
