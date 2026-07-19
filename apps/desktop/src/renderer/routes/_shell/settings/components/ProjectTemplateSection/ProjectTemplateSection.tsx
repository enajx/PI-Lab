import { Button, cn } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { CodeMirrorBuffer } from "../../../../../Editor/components/CodeMirrorBuffer"
import { DEFAULT_EDITOR_SETTINGS } from "../../../../../Editor/hooks/useEditorBuffers"
import { useTRPC } from "../../../../../trpc/react"
import { SettingsSection } from "../SettingsControls"

/**
 * Project template editor (Settings → "Project template"). Edits the writable
 * copy of the bundled template (`~/.pi-lab/template`) that `createFromTemplate`
 * stamps into every new project. A left file list selects a file; the right pane
 * is a workspace-agnostic {@link CodeMirrorBuffer} that loads via `template.read`
 * and saves via `template.write`.
 *
 * The template is seeded once on first run, so the user's edits persist across app
 * updates — and newly bundled files won't appear automatically. `CLAUDE.md` is a
 * symlink, so editing it writes through to `AGENTS.md`.
 *
 * We deliberately do NOT use `useEditorBuffers` (it requires a workspace + the
 * `files.*` router); only the editor theme + vim toggle are reused from
 * `settings.get` so the buffer matches the user's editor preferences.
 */
export function ProjectTemplateSection() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const listQuery = useQuery(trpc.template.list.queryOptions())
  const settingsQuery = useQuery(trpc.settings.get.queryOptions())
  const editor = settingsQuery.data?.editor ?? DEFAULT_EDITOR_SETTINGS

  const files = listQuery.data ?? []
  const [selected, setSelected] = useState<string | null>(null)
  const activeRelPath = selected ?? files[0]?.relPath ?? null

  const readQuery = useQuery({
    ...trpc.template.read.queryOptions({ relPath: activeRelPath ?? "" }),
    enabled: activeRelPath !== null,
  })
  const savedContent = readQuery.data?.content ?? ""

  // The live document for the active file, captured from the buffer's onChange so
  // ⌘S can write it (CodeMirrorBuffer's onSave carries no payload).
  const draftRef = useRef("")
  const [dirty, setDirty] = useState(false)

  // Reset the draft + dirty flag whenever the loaded content changes (a file
  // switch loads new content, or a post-save refetch returns the saved bytes), so
  // a save never writes a stale draft from a previously open file.
  useEffect(() => {
    draftRef.current = savedContent
    setDirty(false)
  }, [savedContent])

  // Clear dirty immediately on selection too, so switching to a different file
  // whose content happens to match the current one still resets the indicator.
  const handleSelect = (relPath: string) => {
    setSelected(relPath)
    setDirty(false)
  }

  const write = useMutation(
    trpc.template.write.mutationOptions({
      onSuccess: () => {
        setDirty(false)
        void queryClient.invalidateQueries({ queryKey: trpc.template.read.queryKey() })
      },
    }),
  )

  const handleChange = (doc: string) => {
    draftRef.current = doc
    setDirty(doc !== savedContent)
  }

  const handleSave = () => {
    if (activeRelPath === null) return
    write.mutate({ relPath: activeRelPath, content: draftRef.current })
  }

  return (
    <SettingsSection
      testId="settings-section-project-template"
      title="Project template"
      description="The starter files copied into every new project. Seeded once on first run — your edits persist across updates, and newly bundled files won't appear automatically. CLAUDE.md is a symlink, so editing it writes through to AGENTS.md."
    >
      <div
        data-testid="template-editor"
        className="flex h-[28rem] min-h-0 overflow-hidden rounded-lg border border-border"
      >
        <nav
          aria-label="Template files"
          className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-border border-r bg-sidebar p-2"
        >
          {files.map((file) => (
            <button
              key={file.relPath}
              type="button"
              data-testid={`template-file-${file.relPath}`}
              data-active={file.relPath === activeRelPath}
              data-feature-label={file.name}
              data-feature-help="Edit this starter file used when creating future projects"
              onClick={() => handleSelect(file.relPath)}
              className={cn(
                "rounded-md px-2 py-1.5 text-left font-mono text-xs transition-colors",
                file.relPath === activeRelPath
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {file.name}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-border border-b px-3">
            <span
              className="truncate font-mono text-foreground text-xs"
              data-testid="template-active"
            >
              {activeRelPath ?? "No files"}
              {dirty ? <span className="ml-1 text-muted-foreground">•</span> : null}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="template-save"
              className="h-6 px-2 text-xs"
              disabled={activeRelPath === null || !dirty || write.isPending}
              data-feature-help="Save this template file for future projects"
              onClick={handleSave}
            >
              Save
            </Button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {activeRelPath !== null && readQuery.isSuccess ? (
              <CodeMirrorBuffer
                key={`${activeRelPath}:${readQuery.dataUpdatedAt}`}
                relPath={activeRelPath}
                initialDoc={savedContent}
                onChange={handleChange}
                onSave={handleSave}
                vim={editor.vim}
                theme={editor.editorTheme}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
                {listQuery.isLoading ? "Loading…" : "Select a file to edit."}
              </div>
            )}
          </div>

          {write.error ? (
            <p
              data-testid="template-error"
              className="shrink-0 cursor-text select-text border-border border-t px-3 py-2 text-destructive text-xs"
            >
              {write.error.message}
            </p>
          ) : null}
        </div>
      </div>
    </SettingsSection>
  )
}
