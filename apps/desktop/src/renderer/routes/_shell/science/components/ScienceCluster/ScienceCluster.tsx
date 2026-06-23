import { Button } from "@skipper/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { DownloadCloud, Eye, EyeOff, Plus, RefreshCw, Server } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useTRPC } from "../../../../../trpc/react"
import { readSshConfigPathOverride } from "../../../utils/sshConfigPathOverride"
import { ScienceTabShell } from "../ScienceTabShell"
import { AddMachineForm, type AddMachineValues } from "./components/AddMachineForm"
import { ImportOptions } from "./components/ImportOptions"
import { MachineCard } from "./components/MachineCard"

/**
 * Cluster science tab (AGENTS.md §1 "Science tabs") — v1 monitoring: list
 * compute machines (imported from `~/.ssh/config` or added by hand), probe each
 * one's reachability, annotate and hide them. No job dispatch / experiment runs —
 * that is v2 and intentionally absent.
 *
 * Reads `science.cluster.list` (hidden excluded by default, with a hidden tally
 * for the "Show hidden (N)" toggle) and drives import / add / hide / annotate /
 * refresh through the matching mutations, invalidating the list on success. The
 * body owns its own scroll per §12.3.
 */
export function ScienceCluster() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const [showHidden, setShowHidden] = useState(false)
  const [adding, setAdding] = useState(false)
  const [importOptionsOpen, setImportOptionsOpen] = useState(false)
  const [refreshingId, setRefreshingId] = useState<string | null>(null)

  const listQuery = useQuery(trpc.science.cluster.list.queryOptions({ includeHidden: showHidden }))

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
      onSettled: () => {
        setRefreshingId(null)
        void invalidateList()
      },
    }),
  )

  // Test seam (AGENTS.md §14): on mount, when loaded with `?sshConfigPath`,
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

  const machines = listQuery.data?.machines ?? []
  const hiddenCount = listQuery.data?.hiddenCount ?? 0

  const addMachineFromForm = (values: AddMachineValues) => addMachine.mutate(values)

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
            onClick={() => setImportOptionsOpen((v) => !v)}
          >
            <DownloadCloud />
            {importConfig.isPending ? "Importing…" : "Import from SSH config"}
          </Button>
          <Button
            data-testid="add-machine"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => setAdding((v) => !v)}
          >
            <Plus />
            Add machine
          </Button>
        </>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
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
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {machines.map((machine) => (
                <MachineCard
                  key={machine.id}
                  machine={machine}
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
              ))}
            </div>
          )}
        </div>
      </div>
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
