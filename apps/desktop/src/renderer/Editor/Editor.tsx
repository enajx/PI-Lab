import type { EditorSettings } from "@skipper/local-db"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useTRPC, useTRPCClient } from "../trpc/react"
import { EditorPane } from "./components/EditorPane"

interface EditorProps {
  /** Workspace whose working dir files are read from / written to. */
  workspaceId: string
  /**
   * Notified after a successful save, with the saved file's working-dir-relative
   * path. Callers can use this to react to edits (e.g. refresh a changes panel).
   */
  onSaved?: (relPath: string) => void
}

/**
 * The built-in editor pane (AGENTS.md §7; spec: TODO "Built-in editor"). A
 * Sublime-style minimal editor mounted next to the terminal in the session view:
 * a file tree + tabs + a CodeMirror buffer, with ⌘S save, dirty tracking,
 * external-change reconciliation, ⌘P quick-open, Python diagnostics, and an
 * in-toolbar settings menu.
 *
 * This thin wrapper owns the app-coupled concerns so the stateful machinery in
 * {@link EditorPane} stays client-injected and testable (AGENTS.md §14): it
 * injects the tRPC client, reads the editor preferences **reactively** (so
 * toggles take effect live), and wires the settings menu to `settings.updateEditor`.
 */
export function Editor({ workspaceId, onSaved }: EditorProps) {
  const client = useTRPCClient()
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const settingsQuery = useQuery(trpc.settings.get.queryOptions())
  const editorSettings = settingsQuery.data?.editor

  const updateEditor = useMutation(
    trpc.settings.updateEditor.mutationOptions({
      // Re-read settings after a write so the menu + editor reflect the new value.
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() })
      },
    }),
  )

  const onUpdateEditorSettings = (patch: Partial<EditorSettings>) => {
    updateEditor.mutate(patch)
  }

  return (
    <EditorPane
      client={client}
      workspaceId={workspaceId}
      editorSettings={editorSettings}
      onUpdateEditorSettings={onUpdateEditorSettings}
      onSaved={onSaved}
    />
  )
}

export type { EditorProps }
