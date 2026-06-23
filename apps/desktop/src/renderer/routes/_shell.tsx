import { createFileRoute, Outlet } from "@tanstack/react-router"
import { Sidebar } from "./_shell/components/Sidebar"

/**
 * Pathless layout route — the default app surface (AGENTS.md §7): a left sidebar
 * placeholder plus a bounded main content area. The content column is a bounded
 * flex child that owns its own vertical scroll (`min-h-0 flex-1 overflow-y-auto`,
 * AGENTS.md §12.3 — never a nested Radix ScrollArea). Child routes render into
 * the `<Outlet />`.
 */
export const Route = createFileRoute("/_shell")({
  component: ShellLayout,
})

function ShellLayout() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
