import { Button, cn } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { DownloadCloud, Eye, EyeOff, Plus, RefreshCw, Server } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { CardGrid, ResizableCardGridItem } from "../../../../../components/CardGrid"
import { useClusterOrder } from "../../../../../preferences/preferences"
import { QuickFind, type QuickFindItem } from "../../../../../QuickFind"
import { eventMatchesShortcut } from "../../../../../shortcuts/shortcuts"
import { useTRPC } from "../../../../../trpc/react"
import type { RouterOutputs } from "../../../../../trpc/types"
import { readSshConfigPathOverride } from "../../../utils/sshConfigPathOverride"
import { ScienceTabShell } from "../ScienceTabShell"
import { AddMachineForm, type AddMachineValues } from "./components/AddMachineForm"
import { ImportOptions } from "./components/ImportOptions"
import { MachineCard, type MachineTelemetry } from "./components/MachineCard"

/** Transient probe telemetry keyed by machine host (never persisted to the DB). */
type TelemetryByHost = Map<string, MachineTelemetry>

/** Pull the telemetry fields out of a probe result for the per-host store. */
function telemetryFrom(
  result: RouterOutputs["science"]["cluster"]["refreshStatus"],
): MachineTelemetry {
  return { gpus: result.gpus, cpuUsage: result.cpuUsage }
}

/** The element type of a cluster-list machine row (live, from the router). */
type ClusterMachine = RouterOutputs["science"]["cluster"]["list"]["machines"][number]

/** A machine's display name: its trimmed annotation label, else the ssh host. */
function displayNameOf(machine: ClusterMachine): string {
  return machine.label?.trim() || machine.host
}

/** Case-insensitive A→Z comparator on the machines' display names. */
function byDisplayName(a: ClusterMachine, b: ClusterMachine): number {
  return displayNameOf(a).localeCompare(displayNameOf(b), undefined, { sensitivity: "base" })
}

/**
 * Order machines for display: any id in the persisted drag order comes first (in
 * that order), then every remaining machine alphabetically by display name — so
 * the default (no stored order) is a clean case-insensitive A→Z list.
 */
function orderMachines(machines: ClusterMachine[], order: string[]): ClusterMachine[] {
  const byId = new Map(machines.map((machine) => [machine.id, machine] as const))
  const seen = new Set<string>()
  const ranked: ClusterMachine[] = []
  for (const id of order) {
    const machine = byId.get(id)
    if (machine && !seen.has(id)) {
      ranked.push(machine)
      seen.add(id)
    }
  }
  const rest = machines.filter((machine) => !seen.has(machine.id)).sort(byDisplayName)
  return [...ranked, ...rest]
}

/**
 * Cluster science tab (AGENTS.md "Scope" "Science tabs") — v1 monitoring: list
 * compute machines (imported from `~/.ssh/config` or added by hand), probe each
 * one's reachability, annotate and hide them. No job dispatch / experiment runs —
 * that is v2 and intentionally absent.
 *
 * Reads `science.cluster.list` (hidden excluded by default, with a hidden tally
 * for the "Show hidden (N)" toggle) and drives import / add / hide / annotate /
 * refresh through the matching mutations, invalidating the list on success. The
 * body owns its own scroll per AGENTS.md Pitfalls #3.
 */
export function ScienceCluster() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const [showHidden, setShowHidden] = useState(false)
  const [adding, setAdding] = useState(false)
  const [importOptionsOpen, setImportOptionsOpen] = useState(false)
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  // Context-aware ⌘F machine finder + the card it last scrolled to (a transient ring).
  const [findOpen, setFindOpen] = useState(false)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Transient GPU / CPU telemetry from the latest probe of each host. Held only
  // in component state (not persisted) since it ages the moment it's read.
  const [telemetry, setTelemetry] = useState<TelemetryByHost>(() => new Map())
  // Persisted custom card order (machine ids) + the live drag-source id.
  const [order, setOrder] = useClusterOrder()
  const [dragId, setDragId] = useState<string | null>(null)

  const listQuery = useQuery(trpc.science.cluster.list.queryOptions({ includeHidden: showHidden }))
  // Span validity follows every live machine, not just the current visible
  // filter. Hiding a machine therefore preserves its layout, while deletion
  // removes its stale persisted span.
  const allMachinesQuery = useQuery(trpc.science.cluster.list.queryOptions({ includeHidden: true }))

  const invalidateList = () =>
    queryClient.invalidateQueries({
      queryKey: trpc.science.cluster.list.queryKey(),
    })

  const importConfig = useMutation(
    trpc.science.cluster.importFromSshConfig.mutationOptions({
      onSuccess: () => {
        setImportOptionsOpen(false)
        void invalidateList()
      },
    }),
  )
  const addMachine = useMutation(
    trpc.science.cluster.addMachine.mutationOptions({
      onSuccess: () => {
        setAdding(false)
        void invalidateList()
      },
    }),
  )
  const setHidden = useMutation(
    trpc.science.cluster.setHidden.mutationOptions({ onSuccess: () => void invalidateList() }),
  )
  const annotate = useMutation(
    trpc.science.cluster.annotate.mutationOptions({ onSuccess: () => void invalidateList() }),
  )
  const refreshStatus = useMutation(
    trpc.science.cluster.refreshStatus.mutationOptions({
      onSuccess: (result) => {
        setTelemetry((prev) => new Map(prev).set(result.machine.host, telemetryFrom(result)))
      },
      onSettled: () => {
        setRefreshingId(null)
        void invalidateList()
      },
    }),
  )

  // Test seam (md/engineering/testing-and-build.md): on mount, when loaded with `?sshConfigPath`,
  // import once from that fixture path so the E2E seeds deterministic machines
  // without touching the real `~/.ssh/config`. A ref guard survives React 19
  // StrictMode's double effect so the import never fires twice.
  const importMutate = importConfig.mutate
  const seamFiredRef = useRef(false)
  useEffect(() => {
    if (seamFiredRef.current) return
    const path = readSshConfigPathOverride()
    if (!path) return
    seamFiredRef.current = true
    importMutate({ path })
  }, [importMutate])

  // Context-aware ⌘F: the quick-open shortcut opens the machine finder. The shell skips every
  // `/science/*` route, so this tab is the sole ⌘F owner while Cluster is on screen.
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (eventMatchesShortcut(event, "quick-open")) {
        event.preventDefault()
        setFindOpen(true)
      }
    }
    window.addEventListener("keydown", onWindowKeyDown)
    return () => window.removeEventListener("keydown", onWindowKeyDown)
  }, [])

  // Clear the post-find ring after a beat so the highlight reads as "I jumped you here", not a
  // persistent selection (the Cluster grid has no selected-machine concept of its own).
  useEffect(() => {
    if (!focusedId) return
    const timer = setTimeout(() => setFocusedId(null), 1500)
    return () => clearTimeout(timer)
  }, [focusedId])

  const machines = listQuery.data?.machines ?? []
  const hiddenCount = listQuery.data?.hiddenCount ?? 0
  const orderedMachines = orderMachines(machines, order)

  // Finder rows: the visible machines (the same set rendered as cards), name-searchable with
  // the connection address as a muted hint. Picking one scrolls its card into view + rings it.
  const findItems: QuickFindItem[] = orderedMachines.map((machine) => {
    const name = displayNameOf(machine)
    const address = machine.hostname ?? machine.host
    return {
      id: machine.id,
      label: name,
      hint: address !== name ? address : undefined,
      icon: Server,
    }
  })

  const focusMachine = (id: string) => {
    setFocusedId(id)
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-machine-id="${id}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }

  const addMachineFromForm = (values: AddMachineValues) => addMachine.mutate(values)

  // Drop the dragged card onto the target's slot, persisting the full visible
  // order (every card becomes "stored", so the arrangement stays stable after).
  const reorderOnto = (targetId: string) => {
    if (!dragId || dragId === targetId) {
      setDragId(null)
      return
    }
    const ids = orderedMachines.map((machine) => machine.id)
    const from = ids.indexOf(dragId)
    const to = ids.indexOf(targetId)
    if (from === -1 || to === -1) {
      setDragId(null)
      return
    }
    ids.splice(from, 1)
    ids.splice(to, 0, dragId)
    setOrder(ids)
    setDragId(null)
  }

  return (
    <ScienceTabShell
      testId="science-cluster"
      title="Cluster"
      subtitle="Monitor compute machines from your ssh config"
      actions={
        <>
          {hiddenCount > 0 ? (
            <Button
              data-testid="show-hidden"
              variant="ghost"
              size="sm"
              data-feature-help="Temporarily include machines hidden from the cluster grid"
              className="h-8 gap-1.5 text-muted-foreground"
              onClick={() => setShowHidden((v) => !v)}
            >
              {showHidden ? <EyeOff /> : <Eye />}
              {showHidden ? "Hide hidden" : `Show hidden (${hiddenCount})`}
            </Button>
          ) : null}
          <Button
            data-testid="refresh-all"
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5"
            disabled={machines.length === 0}
            data-feature-help="Refresh reachability and CPU/GPU telemetry for every visible machine"
            onClick={() => {
              for (const machine of machines) {
                if (!machine.hidden) refreshStatus.mutate({ id: machine.id })
              }
            }}
          >
            <RefreshCw />
            Check all
          </Button>
          <Button
            data-testid="import-ssh-config"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            disabled={importConfig.isPending}
            data-feature-help="Import hosts from your SSH config into Cluster monitoring"
            onClick={() => setImportOptionsOpen((v) => !v)}
          >
            <DownloadCloud />
            {importConfig.isPending ? "Importing…" : "Import from SSH config"}
          </Button>
          <Button
            data-testid="add-machine"
            size="sm"
            data-feature-help="Register a machine manually when it is not in your SSH config"
            className="h-8 gap-1.5"
            onClick={() => setAdding((v) => !v)}
          >
            <Plus />
            Add machine
          </Button>
        </>
      }
    >
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 p-6">
          {importOptionsOpen ? (
            <ImportOptions
              onImport={(path) => importConfig.mutate(path ? { path } : {})}
              onClose={() => setImportOptionsOpen(false)}
              isPending={importConfig.isPending}
            />
          ) : null}

          {adding ? (
            <AddMachineForm
              onSubmit={addMachineFromForm}
              onCancel={() => setAdding(false)}
              isPending={addMachine.isPending}
              error={addMachine.error?.message ?? null}
            />
          ) : null}

          {machines.length === 0 && !adding && !importOptionsOpen ? (
            <EmptyState
              onImport={() => importConfig.mutate({})}
              importing={importConfig.isPending}
            />
          ) : null}
          <CardGrid
            as="ul"
            surface="cluster"
            cardIds={
              allMachinesQuery.data === undefined
                ? null
                : allMachinesQuery.data.machines.map((machine) => machine.id)
            }
            testId="cluster-grid"
            className="gap-3"
            hidden={machines.length === 0}
          >
            {orderedMachines.map((machine) => (
              <ResizableCardGridItem
                as="li"
                key={machine.id}
                cardId={machine.id}
                label={displayNameOf(machine)}
                testId="machine-card-drag"
                data-machine-id={machine.id}
                data-focused={focusedId === machine.id}
                draggable
                onDragStart={(event) => {
                  const target = event.target as HTMLElement
                  // Let buttons, inputs and the selectable error text behave
                  // normally — only a bare card body starts a reorder drag.
                  if (target.closest("input, textarea, button, .select-text")) {
                    event.preventDefault()
                    return
                  }
                  setDragId(machine.id)
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
                }}
                onDragOver={(event) => {
                  if (dragId && dragId !== machine.id) event.preventDefault()
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  reorderOnto(machine.id)
                }}
                onDragEnd={() => setDragId(null)}
                className={cn(
                  "rounded-lg",
                  dragId === machine.id && "opacity-50",
                  focusedId === machine.id && "ring-2 ring-ring",
                )}
              >
                <MachineCard
                  machine={machine}
                  telemetry={telemetry.get(machine.host)}
                  runningProjects={[]}
                  isRefreshing={refreshStatus.isPending && refreshingId === machine.id}
                  onRefresh={() => {
                    setRefreshingId(machine.id)
                    refreshStatus.mutate({ id: machine.id })
                  }}
                  onToggleHidden={() =>
                    setHidden.mutate({ id: machine.id, hidden: !machine.hidden })
                  }
                  onAnnotate={(label) => annotate.mutate({ id: machine.id, label })}
                />
              </ResizableCardGridItem>
            ))}
          </CardGrid>
        </div>
      </div>

      {findOpen ? (
        <QuickFind
          ariaLabel="Find a machine"
          placeholder="Find a machine…"
          scopeLabel="Cluster machines"
          allowGlobalSearch
          items={findItems}
          emptyText="No matching machines"
          onSelect={(item) => focusMachine(item.id)}
          onClose={() => setFindOpen(false)}
        />
      ) : null}
    </ScienceTabShell>
  )
}

/** Empty state shown when no machines have been imported or added yet. */
function EmptyState({ onImport, importing }: { onImport: () => void; importing?: boolean }) {
  return (
    <div
      data-testid="science-cluster-empty"
      className="flex flex-col items-center gap-3 rounded-lg border border-border border-dashed p-12 text-center"
    >
      <Server className="size-8 text-muted-foreground" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="font-medium text-foreground text-sm">No machines yet</p>
        <p className="max-w-sm text-muted-foreground text-xs leading-relaxed">
          Import the hosts from your <code className="font-mono">~/.ssh/config</code>, or add a
          machine by hand to monitor a box that isn't in your ssh config.
        </p>
      </div>
      <Button size="sm" className="gap-1.5" disabled={importing} onClick={onImport}>
        <DownloadCloud />
        {importing ? "Importing…" : "Import from SSH config"}
      </Button>
    </div>
  )
}
