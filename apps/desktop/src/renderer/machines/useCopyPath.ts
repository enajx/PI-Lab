import { useMutation } from "@tanstack/react-query"
import { useTRPC } from "../trpc/react"
import { useMachineScope } from "./machines"

interface CopyPathInput {
  workspaceId: string
  relPath: string
  form: "absolute" | "relative"
}

/**
 * Copy Path for a project entry. For a local project Electron writes the
 * clipboard (`files.copyPath`, which asks this Mac's server); for a project
 * on another machine the path comes from that machine's server and the page
 * writes the clipboard.
 */
export function useCopyPath(onError: (error: { message: string }) => void) {
  const trpc = useTRPC()
  const machine = useMachineScope()
  const local = useMutation(trpc.files.copyPath.mutationOptions({ onError }))
  const remote = useMutation({
    mutationFn: async (input: CopyPathInput): Promise<void> => {
      if (!machine) throw new Error("Not a project on another machine")
      await navigator.clipboard.writeText(await machine.client.files.copyPathText.query(input))
    },
    onError,
  })
  return machine ? remote : local
}
