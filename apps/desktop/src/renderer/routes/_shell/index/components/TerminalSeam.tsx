import { Terminal } from "../../../../Terminal"
import { useTRPCClient } from "../../../../trpc/react"

/** The standalone-terminal test seam, gated to `?termcmd` runs. */
export function TerminalSeam({
  termSpawn,
}: {
  termSpawn: { command?: string; args?: string[]; inputKind: "agent" | "terminal" }
}) {
  // Reuse the ONE app-wide tRPC client (the same instance backing TanStack
  // Query). A second `ipcLink` over the same channel cross-wires responses, so
  // the terminal must share, not create, the client.
  const client = useTRPCClient()
  return (
    <div className="flex h-full flex-col gap-4 p-8">
      <section className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
        <Terminal
          client={client}
          inputKind={termSpawn.inputKind}
          command={termSpawn.command}
          args={termSpawn.args}
        />
      </section>
    </div>
  )
}
