import { Button } from "@skipper/ui"
import { useMutation } from "@tanstack/react-query"
import { Paperclip } from "lucide-react"
import { useState } from "react"
import { useTRPC } from "../../../../../../../trpc/react"

interface AttachFileFlowProps {
  /** Parent item key (`LibraryPaper.id`) to attach the chosen file to. */
  itemKey: string
}

type FlowState = { kind: "idle" } | { kind: "done" } | { kind: "error"; message: string }

/**
 * Per-item "Attach file…" action for the Zotero library list (only rendered when the
 * connection can write — see `ScienceLibrary`). Picks a file via the native dialog
 * (`system.pickFile`) and hands it to `science.library.attachFile`, which writes via
 * the local bridge or the Web API depending on mode. Renders inline success/error so
 * the result is visible next to the item.
 */
export function AttachFileFlow({ itemKey }: AttachFileFlowProps) {
  const trpc = useTRPC()
  const pickFile = useMutation(trpc.system.pickFile.mutationOptions())
  const attach = useMutation(trpc.science.library.attachFile.mutationOptions())
  const [state, setState] = useState<FlowState>({ kind: "idle" })
  const busy = pickFile.isPending || attach.isPending

  const run = async () => {
    setState({ kind: "idle" })
    try {
      const filePath = await pickFile.mutateAsync()
      if (!filePath) return // user cancelled the dialog
      const result = await attach.mutateAsync({ itemKey, filePath })
      setState(
        result.ok
          ? { kind: "done" }
          : { kind: "error", message: result.message ?? "Couldn't attach the file." },
      )
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Attach failed.",
      })
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      {state.kind === "done" ? (
        <span data-testid="library-item-attach-done" className="text-primary text-xs">
          Attached ✓
        </span>
      ) : state.kind === "error" ? (
        <span
          data-testid="library-item-attach-error"
          className="cursor-text select-text text-destructive text-xs"
        >
          {state.message}
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="library-item-attach"
        className="h-7 gap-1.5 text-muted-foreground text-xs"
        disabled={busy}
        onClick={() => void run()}
      >
        <Paperclip className="size-3.5" />
        {busy ? "Attaching…" : "Attach"}
      </Button>
    </div>
  )
}
